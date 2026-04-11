# webns

Multi-chain naming service MCP server. Resolves, registers, and manages blockchain names across 5 chains behind a single endpoint.

**62 tools** across SuiNS (.sui), ENS (.eth), SNS (.sol), Aptos Names (.apt), Basenames (.base.eth), and cross-chain utilities.

## Setup

```bash
git clone https://github.com/ossybadman/WebNS
cd WebNS
npm install
npm start
```

Server runs on port 3000 by default.

## Connect to Claude

Add to your Claude MCP config:

```json
{
  "mcpServers": {
    "webns": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For the hosted endpoint:
```json
{
  "mcpServers": {
    "webns": {
      "type": "http",
      "url": "https://webns-mcp-production.up.railway.app/mcp"
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ETH_RPC_URL` | `https://cloudflare-eth.com` | Ethereum RPC (Alchemy/Infura recommended for production) |
| `SOL_RPC_URL` | Solana mainnet-beta | Solana RPC (Helius/QuickNode recommended for production) |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base L2 RPC |

> **Note:** Public RPCs have rate limits. For production use, set `ETH_RPC_URL` and `SOL_RPC_URL` to private endpoints.

---

## Tools

### Cross-chain

| Tool | Description |
|------|-------------|
| `resolve_any` | Resolve any name — auto-detects chain from TLD (.sui, .eth, .sol, .apt, .base.eth) |
| `reverse_lookup_any` | Find the primary name for an address on any chain |

### SuiNS (.sui) — 17 tools

| Tool | Description |
|------|-------------|
| `sui_resolve_name` | Resolve a .sui name to a wallet address |
| `sui_reverse_lookup` | Find the primary .sui name for an address |
| `sui_get_name_record` | Get full name record including expiry and metadata |
| `sui_check_availability` | Check if a .sui name is available |
| `sui_get_pricing` | Get registration pricing (USDC/SUI/NS) |
| `sui_get_renewal_pricing` | Get renewal pricing |
| `sui_build_register_tx` | Build a registration transaction |
| `sui_build_renew_tx` | Build a renewal transaction |
| `sui_build_create_subname_tx` | Create a subdomain (node subname with NFT) |
| `sui_build_create_leaf_subname_tx` | Create a leaf subdomain (no NFT) |
| `sui_build_remove_leaf_subname_tx` | Remove a leaf subdomain |
| `sui_build_set_target_address_tx` | Set the target address for a name |
| `sui_build_set_default_name_tx` | Set a name as primary for the sender |
| `sui_build_edit_subname_setup_tx` | Edit subdomain configuration |
| `sui_build_extend_expiration_tx` | Extend a subdomain's expiration |
| `sui_build_set_metadata_tx` | Set metadata (avatar, contentHash, walrusSiteId) |
| `sui_build_burn_expired_tx` | Burn an expired name |

### ENS (.eth) — 13 tools

| Tool | Description |
|------|-------------|
| `ens_resolve_name` | Resolve a .eth name to an Ethereum address |
| `ens_reverse_lookup` | Find the primary .eth name for an address |
| `ens_get_name_record` | Get full record: owner, resolver, address, text records |
| `ens_check_availability` | Check if a .eth name is available |
| `ens_get_pricing` | Get registration/renewal price in ETH |
| `ens_get_text_record` | Get a specific text record (avatar, twitter, github, etc.) |
| `ens_get_contenthash` | Get the contenthash (IPFS/IPNS/Swarm) |
| `ens_build_commit_tx` | Step 1 of registration: build commit transaction |
| `ens_build_register_tx` | Step 2 of registration: build register transaction |
| `ens_build_renew_tx` | Build a renewal transaction |
| `ens_build_set_target_address_tx` | Set the ETH address for a name |
| `ens_build_set_default_name_tx` | Set a name as primary |
| `ens_build_set_metadata_tx` | Set text records or contenthash |

> **ENS registration is a 2-step process:** call `ens_build_commit_tx`, execute it, wait 60 seconds, then call `ens_build_register_tx` with the same secret.

### SNS (.sol) — 10 tools

| Tool | Description |
|------|-------------|
| `sol_resolve_name` | Resolve a .sol name to a Solana address |
| `sol_reverse_lookup` | Find all .sol names for an address |
| `sol_get_name_record` | Get full record including all on-chain records |
| `sol_check_availability` | Check if a .sol name is available |
| `sol_get_favorite_domain` | Get the favorite/primary domain for a wallet |
| `sol_list_domains` | List all .sol domains owned by a wallet |
| `sol_build_register_tx` | Build a registration transaction |
| `sol_build_set_target_address_tx` | Set the SOL record for a domain |
| `sol_build_set_default_name_tx` | Set a domain as the favorite/primary |
| `sol_build_set_metadata_tx` | Set a record (url, ipfs, twitter, github, email, etc.) |

> **SNS domains are perpetual** — no expiry, no renewal needed.

### Aptos Names (.apt) — 10 tools

| Tool | Description |
|------|-------------|
| `apt_resolve_name` | Resolve a .apt name to an Aptos address |
| `apt_reverse_lookup` | Find the primary .apt name for an address |
| `apt_get_name_record` | Get full record: owner, target address, expiry |
| `apt_check_availability` | Check if a .apt name is available |
| `apt_get_account_domains` | List all .apt domains owned by an account |
| `apt_build_register_tx` | Build a registration transaction |
| `apt_build_renew_tx` | Build a renewal transaction |
| `apt_build_create_subname_tx` | Create a subdomain |
| `apt_build_set_target_address_tx` | Set the target address for a name |
| `apt_build_set_default_name_tx` | Set a name as primary |

### Basenames (.base.eth) — 10 tools

| Tool | Description |
|------|-------------|
| `base_resolve_name` | Resolve a .base.eth name to an address |
| `base_reverse_lookup` | Find the primary .base.eth name for an address |
| `base_get_name_record` | Get full record: owner, address, text records |
| `base_check_availability` | Check if a .base.eth name is available |
| `base_get_pricing` | Get registration price in ETH on Base |
| `base_build_register_tx` | Build a registration transaction |
| `base_build_renew_tx` | Build a renewal transaction |
| `base_build_set_target_address_tx` | Set the address for a name |
| `base_build_set_default_name_tx` | Set a name as primary |
| `base_build_set_metadata_tx` | Set text records or contenthash |

---

## Transaction Response Format

**Sui / Solana / Aptos** — returns base64 bytes for wallet signing:
```json
{
  "txBytes": "base64-encoded-transaction",
  "note": "Sign and execute with your wallet"
}
```

**Ethereum / Base** — returns unsigned transaction object:
```json
{
  "to": "0x...",
  "data": "0x...",
  "value": "1234567890",
  "valueEth": "0.00123"
}
```

---

## Examples

### Resolve any name
```
resolve_any: { "name": "vitalik.eth" }
resolve_any: { "name": "bonfida.sol" }
resolve_any: { "name": "aptos.apt" }
resolve_any: { "name": "jesse.base.eth" }
```

### Check availability
```
ens_check_availability: { "name": "myname" }
sol_check_availability: { "name": "myname" }
apt_check_availability: { "name": "myname" }
base_check_availability: { "name": "myname" }
```

### Get pricing
```
ens_get_pricing: { "name": "myname", "years": 1 }
sui_get_pricing: { "name": "myname" }
base_get_pricing: { "name": "myname", "years": 1 }
```

### Register a Basename
```
base_build_register_tx: {
  "name": "myname",
  "owner": "0xYourAddress",
  "years": 1
}
```

### Register an ENS name (2-step)
```
# Step 1
ens_build_commit_tx: { "name": "myname", "owner": "0xYourAddress" }
# → save the "secret" from the response
# → execute the transaction, wait 60 seconds

# Step 2
ens_build_register_tx: { "name": "myname", "owner": "0xYourAddress", "secret": "0x..." }
```

---

## Architecture

```
webns/
├── index.mjs           # Entry point — registers all chain modules
├── lib/
│   ├── transport.mjs   # StreamableHTTP + session handling
│   └── helpers.mjs     # mcpResponse(), detectChainFromName()
└── chains/
    ├── sui.mjs         # SuiNS (.sui)     — 17 tools
    ├── ens.mjs         # ENS (.eth)       — 13 tools
    ├── sol.mjs         # SNS (.sol)       — 10 tools
    ├── apt.mjs         # Aptos Names (.apt) — 10 tools
    ├── base.mjs        # Basenames (.base.eth) — 10 tools
    └── cross.mjs       # Cross-chain      —  2 tools
```

## License

MIT
