package backend

import (
	"testing"
	"time"
)

func TestSessionCreatedWithinReauthenticationWindow(t *testing.T) {
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		createdAt time.Time
		want      bool
	}{
		{name: "exactly five minutes is fresh", createdAt: now.Add(-5 * time.Minute), want: true},
		{name: "inside window is fresh", createdAt: now.Add(-5*time.Minute + time.Nanosecond), want: true},
		{name: "older than five minutes is stale", createdAt: now.Add(-5*time.Minute - time.Nanosecond), want: false},
		{name: "future session time is invalid", createdAt: now.Add(time.Nanosecond), want: false},
		{name: "current session is fresh", createdAt: now, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := sessionCreatedWithinReauthenticationWindow(test.createdAt, now); got != test.want {
				t.Fatalf("sessionCreatedWithinReauthenticationWindow(%s, %s) = %t, want %t",
					test.createdAt, now, got, test.want)
			}
		})
	}
}
