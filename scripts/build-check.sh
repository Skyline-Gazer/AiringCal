#!/bin/bash
set -euo pipefail

pnpm -r --if-present build:check
