package backend

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"
)

const openAIResponsesURL = "https://api.openai.com/v1/responses"

const maxOpenAIAPIKeyFileBytes = 16 * 1024

func readOpenAIAPIKeyFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("invalid key file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxOpenAIAPIKeyFileBytes {
		return "", fmt.Errorf("invalid key file")
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxOpenAIAPIKeyFileBytes+1))
	if err != nil || len(contents) > maxOpenAIAPIKeyFileBytes {
		return "", fmt.Errorf("invalid key file")
	}
	key := strings.TrimSpace(string(contents))
	if key == "" {
		return "", fmt.Errorf("invalid key file")
	}
	for _, char := range key {
		if unicode.IsSpace(char) || unicode.IsControl(char) {
			return "", fmt.Errorf("invalid key file")
		}
	}
	return key, nil
}

func openAIResponsesEndpoint(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return openAIResponsesURL, nil
	}
	u, err := url.Parse(raw)
	if err != nil || strings.ContainsAny(raw, "?#") || u.Scheme != "https" || u.Host != "api.openai.com" || u.User != nil || u.RawPath != "" ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("unapproved OpenAI base URL")
	}
	switch u.Path {
	case "", "/", "/v1", "/v1/", "/v1/responses":
		return openAIResponsesURL, nil
	default:
		return "", fmt.Errorf("unapproved OpenAI base URL")
	}
}

// callNativeResponses is the official OpenAI Responses adapter. Its endpoint
// comes from server configuration; callers may inject a loopback endpoint in
// tests, but environment configuration is restricted by openAIResponsesEndpoint.
func callNativeResponses(ctx context.Context, c nativeProviderConfig, instructions string, input any, delta func(string) error) (nativeAIResult, error) {
	if c.Mode != "openai" || c.Endpoint == "" || c.APIKey == "" {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_NOT_CONFIGURED", "AI provider is unavailable", false)
	}
	body, err := jsonBytes(Object{
		"model":        c.Model,
		"stream":       true,
		"store":        false,
		"instructions": instructions,
		"input":        input,
	})
	if err != nil {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI input could not be encoded", false)
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, c.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_CONFIG_INVALID", "Invalid AI endpoint", false)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.APIKey)
	client := providerHTTPClient(timeout)
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nativeAIResult{}, nativeProviderRequestError(requestContext, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := "AI_PROVIDER_HTTP_ERROR"
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			code = "AI_PROVIDER_AUTH_FAILED"
		}
		return nativeAIResult{}, providerFailure(code, fmt.Sprintf("AI provider returned HTTP %d", response.StatusCode), response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusConflict || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500)
	}
	if strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		result, streamErr := readNativeResponsesStream(response.Body, delta)
		if streamErr != nil {
			if requestContext.Err() != nil {
				return result, nativeProviderRequestError(requestContext, streamErr)
			}
			return result, streamErr
		}
		if result.Model == "" {
			result.Model = c.Model
		}
		return result, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxProviderResponse+1))
	if err != nil {
		return nativeAIResult{}, nativeProviderRequestError(requestContext, err)
	}
	if len(data) > maxProviderResponse {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI response exceeds the size budget", false)
	}
	var object Object
	if err := decodeJSON(data, &object); err != nil || object == nil {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned malformed JSON", false)
	}
	return parseNativeResponsesCompleted(object, c.Model, delta)
}

func parseNativeResponsesCompleted(response Object, defaultModel string, delta func(string) error) (nativeAIResult, error) {
	status := strings.ToLower(text(response["status"]))
	switch status {
	case "failed", "incomplete":
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned an unsuccessful response", false)
	case "completed":
	default:
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider response was not completed", false)
	}
	if response["error"] != nil {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_HTTP_ERROR", "AI provider returned an error response", false)
	}
	content, err := nativeResponsesOutputText(response)
	if err != nil {
		return nativeAIResult{}, err
	}
	if err := validateNativeResponsesStructuredText(content); err != nil {
		return nativeAIResult{}, err
	}
	result, err := parseNativeAssistant(content)
	if err != nil {
		return result, err
	}
	if result.Text == "" {
		result.Text = content
	}
	result.Model = text(response["model"])
	if result.Model == "" {
		result.Model = defaultModel
	}
	result.Usage = obj(response["usage"])
	if delta != nil && result.Text != "" {
		if err := delta(result.Text); err != nil {
			return result, err
		}
	}
	return result, nil
}

func validateNativeResponsesStructuredText(raw string) error {
	normalized := strings.TrimSpace(raw)
	if strings.HasPrefix(normalized, "```") {
		normalized = strings.TrimSpace(strings.TrimPrefix(normalized, "```"))
		normalized = strings.TrimSpace(strings.TrimPrefix(normalized, "json"))
		normalized = strings.TrimSpace(strings.TrimSuffix(normalized, "```"))
	}
	if (strings.HasPrefix(normalized, "{") || strings.HasPrefix(normalized, "[")) && !json.Valid([]byte(normalized)) {
		return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned truncated structured output", false)
	}
	return nil
}

func nativeResponsesOutputText(response Object) (string, error) {
	output, ok := response["output"].([]any)
	if !ok {
		return "", providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider response has no output", false)
	}
	var content strings.Builder
	for _, itemValue := range output {
		item := obj(itemValue)
		if text(item["type"]) != "message" {
			continue
		}
		parts, ok := item["content"].([]any)
		if !ok {
			return "", providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned malformed message content", false)
		}
		for _, partValue := range parts {
			part := obj(partValue)
			if text(part["type"]) != "output_text" {
				continue
			}
			partText, ok := part["text"].(string)
			if !ok {
				return "", providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned malformed output text", false)
			}
			content.WriteString(partText)
			if content.Len() > maxProviderResponse {
				return "", providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI output exceeds the size budget", false)
			}
		}
	}
	if content.Len() == 0 {
		return "", providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider response has no output text", false)
	}
	return content.String(), nil
}

func readNativeResponsesStream(reader io.Reader, delta func(string) error) (nativeAIResult, error) {
	const (
		streamUndecided = iota
		streamPlainText
		streamStructured
	)
	limited := &io.LimitedReader{R: reader, N: maxProviderResponse + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4096), 256*1024)
	var dataLines []string
	var eventName string
	var streamedText strings.Builder
	streamMode := streamUndecided
	var result nativeAIResult
	completed := false
	emitDelta := func(piece string) error {
		if delta == nil || piece == "" || streamMode == streamStructured {
			return nil
		}
		if streamMode == streamPlainText {
			return delta(piece)
		}
		for _, char := range piece {
			if unicode.IsSpace(char) {
				continue
			}
			if char == '{' || char == '[' || char == '`' {
				streamMode = streamStructured
				return nil
			}
			streamMode = streamPlainText
			return delta(streamedText.String())
		}
		return nil
	}
	consume := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			return nil
		}
		data := strings.Join(dataLines, "\n")
		dataLines = nil
		var event Object
		if err := decodeJSON([]byte(data), &event); err != nil || event == nil {
			return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "Malformed AI streaming JSON", false)
		}
		typeName := text(event["type"])
		if typeName == "" {
			typeName = eventName
		}
		if typeName == "" || (eventName != "" && eventName != typeName) {
			return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "Malformed AI streaming event", false)
		}
		eventName = ""
		switch typeName {
		case "error", "response.failed", "response.incomplete":
			return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned an unsuccessful streaming response", false)
		case "response.output_text.delta":
			piece, ok := event["delta"].(string)
			if !ok {
				return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider returned malformed output text", false)
			}
			streamedText.WriteString(piece)
			if streamedText.Len() > maxProviderResponse {
				return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI output exceeds the size budget", false)
			}
			return emitDelta(piece)
		case "response.completed":
			response := obj(event["response"])
			if response == nil {
				return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI provider completed event has no response", false)
			}
			outputText, err := nativeResponsesOutputText(response)
			if err != nil {
				return err
			}
			if streamedText.Len() > 0 && streamedText.String() != outputText {
				return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI stream text did not match its completed response", false)
			}
			parsed, err := parseNativeResponsesCompleted(response, "", nil)
			if err != nil {
				return err
			}
			if streamMode != streamPlainText && delta != nil && parsed.Text != "" {
				if err := delta(parsed.Text); err != nil {
					return err
				}
			}
			result = parsed
			completed = true
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := consume(); err != nil {
				return nativeAIResult{}, err
			}
			if completed {
				return result, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimLeft(strings.TrimPrefix(line, "data:"), " "))
		} else if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
	}
	if err := scanner.Err(); err != nil {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI stream was interrupted or exceeded its line budget", false)
	}
	if limited.N <= 0 {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI stream exceeds the byte budget", false)
	}
	if len(dataLines) != 0 || eventName != "" {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI stream ended with an incomplete event frame", false)
	}
	if !completed {
		return nativeAIResult{}, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "AI stream ended without a completed response", true)
	}
	return result, nil
}
