package backend

import (
	"context"
	"errors"
	"net"
)

// Context and http.Client/Transport deadlines are independent timers. A
// transport timeout can arrive while ctx.Err() is still nil; do not relabel it
// as a connection failure merely because the context timer has not fired yet.
func nativeProviderRequestError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var networkError net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) ||
		(errors.As(err, &networkError) && networkError.Timeout()) {
		return providerFailure("AI_PROVIDER_TIMEOUT", "AI provider request timed out after dispatch; its outcome could not be confirmed", true)
	}
	return providerFailure("AI_PROVIDER_NETWORK_ERROR", "AI provider request may have been accepted before the connection failed", true)
}
