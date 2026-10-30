package backend

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var modelURLPrefix = regexp.MustCompile(`(?i)^(?:(?:[a-z][a-z0-9+.-]*://)|(?:https?|ftps?|wss?|file|data|javascript|mailto|blob|tel|ssh):|//|www\.)`)
var modelURLHostPath = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?::[0-9]+)?/`)

func safeModelIdentifier(value, apiKey string) string {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 200 || (apiKey != "" && strings.Contains(value, apiKey)) ||
		modelURLPrefix.MatchString(value) || modelURLHostPath.MatchString(value) {
		return ""
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return ""
		}
	}
	if parsed, err := url.Parse(value); err == nil && parsed.IsAbs() && parsed.Host != "" {
		return ""
	}
	return value
}

func nativeProviderLabel(config nativeProviderConfig) string {
	provider := safeModelIdentifier(config.Mode, config.APIKey)
	if endpoint, err := url.Parse(config.Endpoint); err == nil && endpoint.Hostname() != "" {
		provider = safeModelIdentifier(endpoint.Hostname(), config.APIKey)
	}
	if provider == "" {
		return "unknown"
	}
	return provider
}

func modelInfo(config nativeProviderConfig, echo, requested string, fixture bool) Object {
	model := safeModelIdentifier(echo, config.APIKey)
	basis := "provider_response"
	if model == "" {
		if fixture {
			model = safeModelIdentifier(requested, config.APIKey)
			if model == "" {
				model = "test-fixture"
			}
			basis = "fixture"
		} else {
			model = safeModelIdentifier(requested, config.APIKey)
			basis = "requested"
		}
	}
	if model == "" {
		model, basis = "unknown", "unknown"
	}
	return Object{"source": "api", "provider": nativeProviderLabel(config), "model": model, "modelBasis": basis}
}

// Persist only bounded public provider/model identifiers. Provider echoes are
// untrusted: reject URL-shaped, control-bearing, overlong and credential-bearing labels.
func nativeModelInfo(config nativeProviderConfig, result nativeAIResult) Object {
	if config.Mode == "fixture" {
		return modelInfo(config, "", "test-fixture", true)
	}
	return modelInfo(config, result.Model, config.Model, false)
}

func nativeASRModelInfo(config nativeProviderConfig, responseModel string) Object {
	if config.Mode == "fixture" {
		return modelInfo(config, "", "test-fixture", true)
	}
	return modelInfo(config, responseModel, config.ASRModel, false)
}

func nativeTTSModelInfo(config nativeProviderConfig) Object {
	requested := config.TTSModel
	if config.Mode == "fixture" {
		return modelInfo(config, "", "test-fixture", true)
	}
	return modelInfo(config, "", requested, false)
}

func llmModelInfoFromToolsJSON(raw any) Object {
	value := strings.TrimSpace(text(raw))
	if value == "" || len(value) > 200000 {
		return nil
	}
	var traces []any
	if err := json.Unmarshal([]byte(value), &traces); err != nil {
		return nil
	}
	for _, trace := range traces {
		item := obj(trace)
		if text(item["type"]) == "llm_model" {
			return sanitizeModelInfo(item["llm"])
		}
	}
	return nil
}

func sanitizeModelInfo(value any) Object {
	item := obj(value)
	if item == nil {
		return nil
	}
	source := safeModelIdentifier(text(item["source"]), "")
	provider := safeModelIdentifier(text(item["provider"]), "")
	model := safeModelIdentifier(text(item["model"]), "")
	if source == "" || utf8.RuneCountInString(source) > 40 || provider == "" || model == "" {
		return nil
	}
	result := Object{"source": source, "provider": provider, "model": model}
	switch basis := text(item["modelBasis"]); basis {
	case "provider_response", "requested", "fixture", "unknown":
		result["modelBasis"] = basis
	}
	return result
}
