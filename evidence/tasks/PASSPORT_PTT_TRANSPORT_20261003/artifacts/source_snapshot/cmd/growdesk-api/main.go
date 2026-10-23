package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/WangZhuo2015/growdesk-server/internal/backend"
)

var revision = "development"

func main() {
	if err := run(); err != nil {
		slog.Error("native API stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	inventory := flag.Bool("contract-inventory", false, "print declared/native coverage, not an acceptance verdict")
	version := flag.Bool("version", false, "print build and reference revisions")
	flag.Parse()
	if *version {
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"revision": revision, "reference": assets.ReferenceCommit})
	}
	if *inventory {
		contract, err := backend.LoadContract()
		if err != nil {
			return fmt.Errorf("contract load failed: %w", err)
		}
		s := &backend.Server{Contract: contract, Handlers: map[string]backend.Handler{}, Public: map[string]bool{}}
		s.RegisterBusinessHandlers()
		rows := make([]map[string]any, 0, len(contract.Routes))
		for _, r := range contract.Routes {
			implemented := s.Handlers[r.OperationID] != nil || r.OperationID == "getHealthLive" || r.OperationID == "getHealthReady"
			rows = append(rows, map[string]any{"method": r.Method, "path": r.Path, "operationId": r.OperationID, "implemented": implemented, "verified": false})
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"reference": assets.ReferenceCommit, "acceptance": "IMPLEMENTED_NOT_REVIEWED", "operations": rows})
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	config, err := backend.LoadConfig()
	if err != nil {
		return fmt.Errorf("configuration rejected: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	app, err := backend.NewServer(startup, config, log)
	cancel()
	if err != nil {
		return fmt.Errorf("startup failed: %w", err)
	}
	defer app.Close()
	app.RegisterBusinessHandlers()
	return serveHTTP(ctx, configuredHTTPServer(config, app), log)
}

// A handler context deadline does not interrupt blocked socket writes. Keep
// transport deadlines finite as well, allowing a short error-response grace.
// Future long-lived streams need explicit bounded per-stream deadlines; they
// must not remove the default write limit for ordinary API responses.
func configuredHTTPServer(config backend.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr: config.Address, Handler: handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       config.RequestTimeout,
		WriteTimeout:      config.RequestTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32768,
	}
}

func serveHTTP(ctx context.Context, server *http.Server, log *slog.Logger) error {
	// Bind synchronously: never log a successful listener or exit zero when
	// the address is occupied. Returning lets the caller close DB/Redis first.
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("HTTP listen failed: %w", err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	log.Info("native Go API listening", "address", listener.Addr().String(), "revision", revision, "reference", assets.ReferenceCommit)
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("HTTP server failed: %w", err)
		}
		return nil
	case <-ctx.Done():
		shutdown, release := context.WithTimeout(context.Background(), 20*time.Second)
		defer release()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return fmt.Errorf("HTTP shutdown failed: %w", err)
		}
		return nil
	}
}
