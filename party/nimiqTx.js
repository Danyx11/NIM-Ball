// Pure-JS Nimiq Albatross "Basic transaction" builder, signer and broadcaster
// — the OUTGOING counterpart to party/partnership.js's read-only
// fetchNimiqTransaction (which only ever verifies a transaction some client
// wallet already signed and sent). Nothing in this codebase signs/sends NIM
// anywhere else — @nimiq/mini-app-sdk and @nimiq/hub-api (see src/nimiq.js)
// only ever trigger a signature prompt in the PLAYER's own connected wallet,
// never the server's. This module exists specifically for party/prize.js's
// hot wallet (see that file's own header comment).
//
// The binary format below is NOT documented in any npm package — no
// actively-maintained pure-JS Albatross transaction builder exists (the
// official @nimiq/core is a WASM-wrapped full node, and the old pure-JS
// nimiq-core is PoW-era with a different, incompatible format). Every field
// here was derived from core-rs-albatross's own source (primitives/
// transaction/src/lib.rs, signature_proof.rs, account/basic_account.rs,
// keys/src/address.rs) and empirically verified twice before being trusted
// with real funds: (1) round-tripped a hand-built transaction through the
// public RPC's getRawTransactionInfo (read-only decode, no broadcast) and
// confirmed every field decoded back correctly; (2) pulled a REAL mainnet
// transaction, rebuilt its serialize_content() from the RPC's own decoded
// fields, and confirmed the Ed25519 signature in its proof verifies over
// those raw bytes (with negative controls: signing a Blake2b hash instead,
// or omitting the trailing sender_data byte, both correctly failed to
// verify). If core-rs-albatross ever changes this wire format (there is no
// version byte in the payload itself), this file needs re-verifying the same
// way, not just re-reading the source.
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';

// @noble/ed25519 v3+ needs a sha512 implementation wired in for the sync
// sign()/getPublicKey() calls this file uses (verified working in a plain
// Node harness — see conversation). The async variants would use WebCrypto
// automatically, but the sync ones are simpler to reason about here and
// Workers' Web Crypto exposes SHA-512 through @noble/hashes just fine (pure
// JS, no Node builtins).
ed.hashes.sha512 = sha512;

// Base32 alphabet Nimiq addresses use — NOT RFC 4648 (no I/O/W/Z, to avoid
// visual confusion with 1/0). Copied from the exact same constant
// @nimiq/utils's ValidationUtils.NIMIQ_ALPHABET uses (that package is
// already a dependency here, see package.json) — this file duplicates it
// rather than importing that browser-oriented package into the Worker
// bundle for one string.
const NIMIQ_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY';

export const MAIN_ALBATROSS_NETWORK_ID = 24; // NOT 42 — that's the legacy PoW network id.
export const TEST_ALBATROSS_NETWORK_ID = 5;

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += NIMIQ_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += NIMIQ_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of str) {
    const idx = NIMIQ_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid Nimiq address character: ${c}`);
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Uint8Array.from(out);
}

// IBAN-style mod-97 checksum, same algorithm as (and cross-checked against)
// @nimiq/utils's ValidationUtils._ibanCheck — see that file's own comment
// for the "copied from nimiq/core's Address.js" provenance. `str` is the
// full checksum-position-normalized string (see toUserFriendlyAddress/
// fromUserFriendlyAddress below for the "move first 4 chars to the end"
// step this expects to already have been done by the caller... actually
// done HERE, kept in one place rather than split across both callers).
function ibanCheck(fullAddressNoSpaces) {
  const rearranged = fullAddressNoSpaces.slice(4) + fullAddressNoSpaces.slice(0, 4);
  let num = '';
  for (const c of rearranged) {
    if (c >= '0' && c <= '9') num += c;
    else if (c >= 'A' && c <= 'Z') num += String(c.charCodeAt(0) - 55);
    else throw new Error(`Invalid character in address checksum: ${c}`);
  }
  let checksum = 0;
  for (const d of num) checksum = (checksum * 10 + Number(d)) % 97;
  return checksum;
}

// 20 raw address bytes -> "NQ.. .... ...." display form.
export function toUserFriendlyAddress(bytes) {
  const b32 = base32Encode(bytes);
  const check = String(98 - ibanCheck(`NQ00${b32}`)).padStart(2, '0');
  return `NQ${check}${b32}`.replace(/.{4}/g, '$& ').trim();
}

// "NQ.. .... ...." (spaces optional) -> 20 raw address bytes. Throws on a
// malformed/checksum-invalid address — callers should let this reject rather
// than silently sending to a mistyped address.
export function fromUserFriendlyAddress(input) {
  const s = String(input).replace(/\s+/g, '').toUpperCase();
  if (!s.startsWith('NQ')) throw new Error('Nimiq addresses start with NQ');
  if (s.length !== 36) throw new Error('Nimiq addresses are 36 characters (ignoring spaces)');
  if (ibanCheck(s) !== 1) throw new Error('Invalid Nimiq address checksum');
  return base32Decode(s.slice(4));
}

// Blake2b-256 of the raw 32-byte Ed25519 public key, truncated to 20 bytes —
// see keys/src/address.rs in core-rs-albatross.
export function addressFromPublicKey(publicKey) {
  return blake2b(publicKey, { dkLen: 32 }).slice(0, 20);
}

function u64be(value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(value));
  return b;
}
function u32be(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value);
  return b;
}
function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
export function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const clean = hex.trim().replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// The exact bytes an Ed25519 signature is computed over — NOT a hash of
// them (Ed25519 does its own internal SHA-512 per RFC 8032; verified this is
// what core-rs-albatross itself signs, see this file's header comment).
// Basic account <-> Basic account, no recipient data, no flags — the only
// shape party/prize.js ever needs (a plain value transfer, no memo).
function serializeContent({ senderAddress, recipientAddress, valueLuna, feeLuna, validityStartHeight, networkId }) {
  return concatBytes(
    new Uint8Array([0x00, 0x00]),   // recipient_data length, u16 BE = 0 (no data)
    senderAddress,                  // 20 bytes
    new Uint8Array([0x00]),         // sender_type = Basic
    recipientAddress,               // 20 bytes
    new Uint8Array([0x00]),         // recipient_type = Basic
    u64be(valueLuna),               // Coin is fixint BE, NOT postcard varint
    u64be(feeLuna),
    u32be(validityStartHeight),
    new Uint8Array([networkId]),    // raw discriminant (24 = MainAlbatross), not a serde variant index
    new Uint8Array([0x00]),         // flags = empty
    new Uint8Array([0x00]),         // sender_data: postcard Vec<u8> length 0 (present because Albatross)
  );
}

// The "Basic" transaction wire format sendRawTransaction expects — a
// compact form that omits the sender address (recovered from the public key
// on the receiving node) and the SignatureProof's merkle-path byte (implied
// empty for a plain single-sig spend). 139 bytes for a no-fee, no-data
// transfer: 1 (variant tag) + 1 (proof type/flags) + 32 (pubkey) + 20
// (recipient) + 8 (value) + 8 (fee) + 4 (validity_start_height) + 1
// (network id) + 64 (signature).
function serializeBasicWire({ publicKey, recipientAddress, valueLuna, feeLuna, validityStartHeight, networkId, signature }) {
  return concatBytes(
    new Uint8Array([0x00]), // postcard enum variant tag: TransactionFormat::Basic = 0
    new Uint8Array([0x00]), // SignatureProof type_and_flags: Ed25519, no WebAuthn
    publicKey,               // 32
    recipientAddress,        // 20
    u64be(valueLuna),
    u64be(feeLuna),
    u32be(validityStartHeight),
    new Uint8Array([networkId]),
    signature,                // 64
  );
}

// privateKeyHex: 64 hex chars = the raw 32-byte Ed25519 seed, exactly the
// format a Nimiq wallet (Hub/Keyguard) exports as its "private key" — no
// BIP39/derivation step needed. Returns the fully signed, ready-to-broadcast
// raw hex plus the transaction id (Blake2b-256 of serialize_content(), the
// same value the chain will report back from getTransactionByHash — see
// party/partnership.js's own fetchNimiqTransaction) so a caller can persist
// it locally BEFORE broadcasting, in case the broadcast call itself times
// out (see party/prize.js).
export function buildAndSignBasicTransaction({
  privateKeyHex, recipientAddress, valueLuna, feeLuna = 0, validityStartHeight, networkId,
}) {
  if (!privateKeyHex || typeof privateKeyHex !== 'string') throw new Error('privateKeyHex required');
  const privateKey = fromHex(privateKeyHex);
  if (privateKey.length !== 32) throw new Error('privateKeyHex must be 32 bytes (64 hex chars)');
  const publicKey = ed.getPublicKey(privateKey);
  const senderAddress = addressFromPublicKey(publicKey);
  const recipientBytes = typeof recipientAddress === 'string' ? fromUserFriendlyAddress(recipientAddress) : recipientAddress;
  if (recipientBytes.length !== 20) throw new Error('recipient address must be 20 raw bytes');

  const params = { senderAddress, recipientAddress: recipientBytes, valueLuna, feeLuna, validityStartHeight, networkId };
  const content = serializeContent(params);
  const signature = ed.sign(content, privateKey);
  const rawBytes = serializeBasicWire({ publicKey, signature, ...params });
  const txId = toHex(blake2b(content, { dkLen: 32 }));
  return { rawHex: toHex(rawBytes), txId, senderAddress: toUserFriendlyAddress(senderAddress) };
}

const RPC_TIMEOUT_MS = 10_000;
const FETCH_USER_AGENT = 'NimiCurl-Prize-Worker/1.0';

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': FETCH_USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nimiq RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || `Nimiq RPC error (${method})`);
  return body.result?.data;
}

// Current chain height — used as the transaction's validity_start_height
// (must be within [height-60, height+7200) per Albatross's transaction
// validity window; using the live height keeps this comfortably inside that
// window without hardcoding chain-specific constants here).
export async function getBlockNumber(rpcUrl) {
  const height = await rpcCall(rpcUrl, 'getBlockNumber', []);
  if (typeof height !== 'number') throw new Error('Nimiq RPC: unexpected getBlockNumber response');
  return height;
}

// Broadcasts a fully signed raw transaction (hex, no 0x prefix). Returns the
// txid the node computed on decode — should match buildAndSignBasicTransaction's
// own locally-computed txId; party/prize.js doesn't hard-fail on a mismatch
// (the local one is what actually gets persisted/tracked) but it would be
// a strong signal something upstream changed.
export async function sendRawTransaction(rpcUrl, rawHex) {
  const txId = await rpcCall(rpcUrl, 'sendRawTransaction', [rawHex]);
  if (typeof txId !== 'string') throw new Error('Nimiq RPC: unexpected sendRawTransaction response');
  return txId;
}
