# NimiCurl

**A free-to-play multiplayer curling game powered by Nimiq.**

NimiCurl is a simple 2D curling game designed to make discovering Nimiq feel natural: **invite someone, play a match, have fun, and come back.**

It is built around a simple idea:

> **Don't explain the ecosystem first. Give people a reason to enter it.**

## 🎮 The Game

NimiCurl is designed for quick multiplayer matches between friends or other players.

You can:

* Play remotely with another player using a simple match code.
* Play asynchronous **Week** matches when you don't have time to play simultaneously.
* Play locally or against AI.
* Connect your Nimiq wallet and build a persistent player identity.
* Track your matches and progress through the League.

The game is deliberately free to play. There is no entry fee and no requirement to own NIM to enjoy the core gameplay.

## 🪙 NIM as Part of the Experience

NIM is not just displayed in NimiCurl — it has an actual purpose within the game.

### 🏆 Win NIM by playing

Players with a connected Nimiq wallet can earn **10 NIM for eligible match victories**.

To keep the game accessible and avoid turning matches into wagers:

* Playing is completely free.
* There is no betting or staking between players.
* Only Remote and Week matches between two connected wallets are eligible.
* Match results are validated server-side before a reward is issued.
* Daily and per-wallet limits help prevent abuse.
* If the daily reward budget is exhausted, the match still plays normally.

This creates a simple loop:

**Connect → Play → Win → Earn NIM**

The wallet therefore has a tangible role in the player's experience, while remaining completely optional for players who simply want to play.

### 🤝 NIM-powered partnerships

NimiCurl also uses NIM for its partnership system.

Partners can purchase in-game banner placements using NIM, creating a small economy around the game and its community.

This creates a second NIM-powered loop:

**Partner → Pay in NIM → Support the game**

## 🌐 Why NimiCurl?

NimiCurl is built around a broader idea for Nimiq:

**Fun can be an entry point into an ecosystem.**

Instead of starting with wallets, blockchain concepts or financial products, NimiCurl starts with something familiar: a game that people can invite their friends to play.

A player can discover NimiCurl through an invitation, play without needing to understand Nimiq, and gradually encounter Nimiq identity, wallets and NIM rewards as part of the experience.

The intended journey is:

**DISCOVER → PLAY → RETURN → BELONG**

## ⚡ Built for Nimiq

NimiCurl is built as a Nimiq Pay Mini App and uses Nimiq for:

* Wallet connection and player identity.
* Nimiq wallet addresses and official identicons.
* NIM rewards for eligible victories.
* NIM payments for partnerships.

The game is designed to work across devices while keeping the gameplay itself lightweight and accessible.

## 🛠️ Technology

NimiCurl is built with:

* **Vite**
* **Canvas 2D** for the game engine
* **Cloudflare Workers**
* **Cloudflare Durable Objects** for multiplayer state and server-side validation
* **Nimiq Mini App SDK**

The project is open source and released under the **MIT License**.

## 🚀 The Bigger Picture

NimiCurl is intentionally small in scope, but the concept can grow beyond a single game.

The same infrastructure can support persistent leagues, tournaments, sponsorships, player identity and other NIM-powered mechanics over time.

The objective is simple:

**Make Nimiq something people use because they are having fun — not something they have to study first.**
