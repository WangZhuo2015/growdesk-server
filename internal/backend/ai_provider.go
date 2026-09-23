package backend

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type nativeAIAction struct {
	ActionID string `json:"actionId"`
	EntityType string `json:"entityType"`
	Operation string `json:"operation"`
	Summary string `json:"summary"`
	Payload Object `json:"payload"`
}
type nativeAIResult struct { Text string; Actions []nativeAIAction; Usage Object }
type nativeProviderConfig struct { Mode,Endpoint,APIKey,Model,Fixture,ASRModel string; Timeout time.Duration }
type nativeProviderError struct { Code string; Retryable bool; Message string }
func(e *nativeProviderError)Error()string{return e.Message}
func providerFailure(code,message string,retryable bool)error{return &nativeProviderError{Code:code,Message:message,Retryable:retryable}}
const maxProviderResponse = 4*1024*1024

func nativeProviderConfiguration()(nativeProviderConfig,error){
	c:=nativeProviderConfig{Mode:strings.ToLower(strings.TrimSpace(os.Getenv("GROWDESK_AI_PROVIDER"))),Timeout:10*time.Second,Model:strings.TrimSpace(os.Getenv("GROWDESK_AI_MODEL")),ASRModel:strings.TrimSpace(os.Getenv("GROWDESK_ASR_MODEL"))}
	if raw:=os.Getenv("GROWDESK_AI_TIMEOUT_MS");raw!=""{n,e:=strconv.ParseInt(raw,10,64);if e!=nil||n<100||n>180000{return c,apiError(500,"AI_PROVIDER_CONFIG_INVALID","AI timeout must be between 100 and 180000 milliseconds")};c.Timeout=time.Duration(n)*time.Millisecond}
	if c.Mode=="fixture"{c.Fixture=os.Getenv("GROWDESK_AI_FIXTURE_RESPONSE");if c.Fixture==""{c.Fixture=os.Getenv("GROWDESK_AI_FIXTURE_TEXT")};if c.Fixture!=""{return c,nil}}
	if c.Mode=="openai"||c.Mode=="compat"{c.Mode="openai-compatible"}
	if c.Mode=="openai-compatible"{
		c.APIKey=strings.TrimSpace(os.Getenv("GROWDESK_AI_API_KEY"));if c.APIKey==""{c.APIKey=strings.TrimSpace(os.Getenv("AI_API_KEY"))};if c.APIKey==""{c.APIKey=strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))}
		u,err:=url.Parse(strings.TrimSpace(os.Getenv("GROWDESK_AI_BASE_URL")))
		if err==nil&&u.Hostname()!=""&&(u.Scheme=="https"||u.Scheme=="http")&&u.User==nil&&u.RawQuery==""&&u.Fragment==""&&c.APIKey!=""{
			u.Path=strings.TrimRight(u.Path,"/");if !strings.HasSuffix(u.Path,"/chat/completions"){u.Path+="/chat/completions"};c.Endpoint=u.String()
			if c.Model==""{c.Model="gpt-4o-mini"};if c.ASRModel==""{c.ASRModel="whisper-1"};return c,nil
		}
	}
	return c,apiError(503,"AI_PROVIDER_NOT_CONFIGURED","Configure an approved AI provider, or an explicit isolated-test fixture")
}

func providerHTTPClient(timeout time.Duration)*http.Client{
	return &http.Client{Timeout:timeout,Transport:&http.Transport{Proxy:http.ProxyFromEnvironment,DialContext:(&net.Dialer{Timeout:5*time.Second,KeepAlive:30*time.Second}).DialContext,TLSHandshakeTimeout:5*time.Second,ResponseHeaderTimeout:timeout,IdleConnTimeout:30*time.Second,MaxIdleConns:8,MaxIdleConnsPerHost:4,MaxConnsPerHost:8},CheckRedirect:func(*http.Request,[]*http.Request)error{return http.ErrUseLastResponse}}
}

var actionUUID=regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
func parseNativeAssistant(raw string)(nativeAIResult,error){
	out:=nativeAIResult{Text:raw,Actions:[]nativeAIAction{}}
	normalized:=strings.TrimSpace(raw)
	if strings.HasPrefix(normalized,"```")&&strings.HasSuffix(normalized,"```"){normalized=strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(normalized,"```"),"```"));normalized=strings.TrimSpace(strings.TrimPrefix(normalized,"json"))}
	var object Object
	if err:=decodeJSON([]byte(normalized),&object);err!=nil||object==nil{return out,nil}
	out.Text=text(object["text"]);out.Usage=obj(object["usage"])
	actions:=object["actions"];if actions==nil{actions=object["proposedActions"]};if actions==nil{return out,nil}
	items,ok:=actions.([]any);if !ok||len(items)>32{return out,providerFailure("AI_PROVIDER_INVALID_RESPONSE","Provider returned an invalid action list",false)}
	seen:=map[string]bool{}
	for _,item:=range items{
		a:=obj(item);action:=nativeAIAction{ActionID:text(a["actionId"]),EntityType:text(a["entityType"]),Operation:text(a["operation"]),Summary:text(a["summary"]),Payload:obj(a["payload"])}
		if !actionUUID.MatchString(action.ActionID)||seen[action.ActionID]||action.EntityType==""||action.Operation==""||action.Summary==""||action.Payload==nil{return out,providerFailure("AI_PROVIDER_INVALID_RESPONSE","Provider returned an invalid or duplicate action",false)}
		seen[action.ActionID]=true;out.Actions=append(out.Actions,action)
	}
	return out,nil
}

func callNativeAI(ctx context.Context,c nativeProviderConfig,sessionID,babyID,message string,attachments []string,delta func(string)error)(nativeAIResult,error){
	if len(message)>256*1024||len(attachments)>16{return nativeAIResult{},providerFailure("AI_INPUT_TOO_LARGE","AI input exceeds the configured budget",false)}
	if c.Mode=="fixture"{
		select{case<-ctx.Done():return nativeAIResult{},ctx.Err();default:}
		if c.Fixture==""{return nativeAIResult{},providerFailure("AI_PROVIDER_NOT_CONFIGURED","Explicit fixture content is required",false)}
		result,err:=parseNativeAssistant(c.Fixture);if err==nil&&delta!=nil&&result.Text!=""{err=delta(result.Text)};return result,err
	}
	if c.Mode!="openai-compatible"||c.Endpoint==""||c.APIKey==""{return nativeAIResult{},providerFailure("AI_PROVIDER_NOT_CONFIGURED","AI provider is unavailable",false)}
	requestBody:=Object{"model":c.Model,"stream":true,"messages":[]Object{{"role":"system","content":"You are GrowDesk's private baby-care assistant. Return JSON with a text string and an actions array. Use an empty actions array for read-only answers. Actions are proposals only; never claim a write has occurred. The server supplies the authorization scope."},{"role":"user","content":message}},"metadata":Object{"sessionId":sessionID,"babyId":babyID,"attachmentIds":attachments}}
	raw,err:=jsonBytes(requestBody);if err!=nil{return nativeAIResult{},err}
	ctx,cancel:=context.WithTimeout(ctx,c.Timeout);defer cancel()
	req,err:=http.NewRequestWithContext(ctx,http.MethodPost,c.Endpoint,bytes.NewReader(raw));if err!=nil{return nativeAIResult{},providerFailure("AI_PROVIDER_CONFIG_INVALID","Invalid AI endpoint",false)}
	req.Header.Set("Content-Type","application/json");req.Header.Set("Authorization","Bearer "+c.APIKey)
	client:=providerHTTPClient(c.Timeout);defer client.CloseIdleConnections()
	response,err:=client.Do(req)
	if err!=nil{if errors.Is(ctx.Err(),context.DeadlineExceeded){return nativeAIResult{},providerFailure("AI_PROVIDER_TIMEOUT","AI provider request timed out",true)};if ctx.Err()!=nil{return nativeAIResult{},ctx.Err()};return nativeAIResult{},providerFailure("AI_PROVIDER_NETWORK_ERROR","AI provider connection failed",true)}
	defer response.Body.Close()
	if response.StatusCode<200||response.StatusCode>=300{code:="AI_PROVIDER_HTTP_ERROR";if response.StatusCode==401||response.StatusCode==403{code="AI_PROVIDER_AUTH_FAILED"};return nativeAIResult{},providerFailure(code,fmt.Sprintf("AI provider returned HTTP %d",response.StatusCode),response.StatusCode==408||response.StatusCode==409||response.StatusCode==429||response.StatusCode>=500)}
	if strings.Contains(strings.ToLower(response.Header.Get("Content-Type")),"text/event-stream"){return readNativeAIStream(response.Body,delta)}
	body,err:=io.ReadAll(io.LimitReader(response.Body,maxProviderResponse+1));if err!=nil{return nativeAIResult{},err};if len(body)>maxProviderResponse{return nativeAIResult{},providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI response exceeds the size budget",false)}
	var object Object;if err=decodeJSON(body,&object);err!=nil{return nativeAIResult{},providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI provider returned malformed JSON",false)}
	choices,ok:=object["choices"].([]any);if !ok||len(choices)==0{return nativeAIResult{},providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI provider returned no choices",false)}
	content:=text(obj(obj(choices[0])["message"])["content"])
	result,err:=parseNativeAssistant(content);if err!=nil{return result,err};if result.Text==""{result.Text=content};result.Usage=obj(object["usage"])
	if delta!=nil&&result.Text!=""{err=delta(result.Text)};return result,err
}

// Stream chunks are processed as they arrive. The byte, line and aggregate
// budgets bound memory; cancellation closes the HTTP body through its context.
func readNativeAIStream(reader io.Reader,delta func(string)error)(nativeAIResult,error){
	limited:=&io.LimitedReader{R:reader,N:maxProviderResponse+1}
	scanner:=bufio.NewScanner(limited);scanner.Buffer(make([]byte,4096),256*1024)
	var frame []string
	var content,arguments strings.Builder
	var usage Object
	done:=false
	consume:=func()error{
		if len(frame)==0{return nil};data:=strings.Join(frame,"\n");frame=nil
		if data=="[DONE]"{done=true;return nil}
		var object Object;if err:=decodeJSON([]byte(data),&object);err!=nil{return providerFailure("AI_PROVIDER_INVALID_RESPONSE","Malformed AI streaming JSON",false)}
		if value:=obj(object["usage"]);value!=nil{usage=value}
		choices,_:=object["choices"].([]any);if len(choices)==0{return nil}
		chunk:=obj(obj(choices[0])["delta"]);textDelta:=text(chunk["content"])
		content.WriteString(textDelta)
		if calls,ok:=chunk["tool_calls"].([]any);ok{for _,call:=range calls{arguments.WriteString(text(obj(obj(call)["function"])["arguments"]))}}
		if content.Len()+arguments.Len()>maxProviderResponse{return providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI output exceeds the size budget",false)}
		if delta!=nil&&textDelta!=""{return delta(textDelta)};return nil
	}
	for scanner.Scan(){line:=scanner.Text();if line==""{if err:=consume();err!=nil{return nativeAIResult{},err};if done{break}}else if strings.HasPrefix(line,"data:"){frame=append(frame,strings.TrimLeft(strings.TrimPrefix(line,"data:")," "))}}
	if err:=scanner.Err();err!=nil{return nativeAIResult{},providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI stream exceeded its line budget or was interrupted",false)}
	if limited.N<=0{return nativeAIResult{},providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI stream exceeds the byte budget",false)}
	if err:=consume();err!=nil{return nativeAIResult{},err}
	if !done{return nativeAIResult{},providerFailure("AI_PROVIDER_INVALID_RESPONSE","AI stream ended without its completion marker",true)}
	result,err:=parseNativeAssistant(content.String());if err!=nil{return result,err}
	if result.Text==""{result.Text=content.String()};result.Usage=usage
	if arguments.Len()>0{
		var tool any;if err:=decodeJSON([]byte(arguments.String()),&tool);err!=nil{return result,providerFailure("AI_PROVIDER_INVALID_RESPONSE","Malformed AI tool arguments",false)}
		if obj(tool)==nil{tool=Object{"actions":tool}}
		raw,err:=jsonText(tool);if err!=nil{return result,err};parsed,err:=parseNativeAssistant(raw);if err!=nil{return result,err};result.Actions=parsed.Actions
	}
	return result,nil
}
