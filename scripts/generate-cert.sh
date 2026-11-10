#!/usr/bin/env bash
# Creates a self-signed certificate for localhost in ./certs.
# Browsers only speak HTTP/2 over TLS, so the backend needs one.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "Wrote $dir/cert.pem and $dir/key.pem"
