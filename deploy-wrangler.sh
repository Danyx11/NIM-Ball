#!/bin/bash
# One-off helper for deploying the "Match réseau" arbiter (party/arbiter.js)
# to your own Cloudflare account via wrangler (see CLAUDE.md "Network match"
# — migrated off the legacy `partykit` CLI, which couldn't generate a
# free-plan-compatible Durable Object migration). Prompts for the API token
# as hidden input (like a password) so it never appears in shell history,
# logs, or gets typed/pasted anywhere else.
set -e

CLOUDFLARE_ACCOUNT_ID="96082811de7f843c75577ea7d8bc1201"

read -s -p "Colle ton token Cloudflare API puis appuie sur Entrée (rien ne s'affichera, c'est normal) : " CLOUDFLARE_API_TOKEN
echo ""
echo ""

CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler deploy
