// Package config reads runtime settings from the environment.
// Only DATA_DIR and LIBRARY_DIR point at the host; everything else is relative to them.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr       string
	DataDir    string
	LibraryDir string
	Password   string
	Workers    int
	TrashDays  int
}

func Load() Config {
	return Config{
		Addr:       env("ADDR", ":8080"),
		DataDir:    env("DATA_DIR", "/data"),
		LibraryDir: env("LIBRARY_DIR", "/library"),
		Password:   os.Getenv("APP_PASSWORD"),
		Workers:    envInt("WORKERS", 1),
		TrashDays:  envInt("TRASH_DAYS", 30),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
}
