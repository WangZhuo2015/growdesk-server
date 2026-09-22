package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
)

func TestHTTPBindFailureIsReturned(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := serveHTTP(context.Background(), &http.Server{Addr: listener.Addr().String()}, log); err == nil {
		t.Fatal("occupied address was treated as a successful shutdown")
	}
}
