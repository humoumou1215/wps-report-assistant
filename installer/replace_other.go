//go:build !windows

package main

func retryReplacement(err error) bool { return false }
