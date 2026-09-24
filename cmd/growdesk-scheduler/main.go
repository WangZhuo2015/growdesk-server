package main

import (
	"context"
	"encoding/json"
	"flag"
	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/WangZhuo2015/growdesk-server/internal/backend"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

var revision = "development"

func main() {
	once := flag.Bool("once", false, "process one bounded iteration and exit")
	version := flag.Bool("version", false, "print the source revision")
	flag.Parse()
	if *version {
		if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"revision": revision, "reference": assets.ReferenceCommit}); err != nil {
			os.Exit(1)
		}
		return
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if err := backend.RunNativeRuntime(ctx, "scheduler", *once, log); err != nil {
		log.Error("native process stopped", "error", err)
		os.Exit(1)
	}
}
