package backend

import (
	"context"
	"errors"
	"sort"
	"strings"

	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/jackc/pgx/v5"
)

// ApplyNativeMigrations requires the same explicitly isolated test identity as
// the preview API. Never run migrations implicitly during service startup.
func ApplyNativeMigrations(ctx context.Context) error {
	c, err := LoadConfig()
	if err != nil {
		return err
	}
	db, err := openDatabase(ctx, c)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(9836172001)`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS native_go;
		CREATE TABLE IF NOT EXISTS native_go.migrations(name text PRIMARY KEY,sha256 char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	files, err := assets.NativeMigrations.ReadDir("native/migrations")
	if err != nil {
		return err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".sql") {
			continue
		}
		raw, err := assets.NativeMigrations.ReadFile("native/migrations/" + file.Name())
		if err != nil {
			return err
		}
		hash := hashText(string(raw))
		var existing string
		err = tx.QueryRow(ctx, `SELECT sha256 FROM native_go.migrations WHERE name=$1`, file.Name()).Scan(&existing)
		if err == nil {
			if strings.TrimSpace(existing) != hash {
				return errors.New("native migration checksum changed")
			}
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err = tx.Exec(ctx, string(raw)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO native_go.migrations(name,sha256) VALUES($1,$2)`, file.Name(), hash); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
