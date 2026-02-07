# Chains API

A Node.js API query service built with Fastify that indexes and provides access to blockchain chain data from multiple sources.

## Features

- **Multi-Source Data Aggregation**: Combines data from multiple blockchain registries:
  - [The Graph Networks Registry](https://raw.githubusercontent.com/Johnaverse/networks-registry/refs/heads/main/public/TheGraphNetworksRegistry.json)
  - [Chainlist RPCs](https://chainlist.org/rpcs.json)
  - [Chain ID Network](https://chainid.network/chains.json)
  - [SLIP-0044 Coin Types](https://github.com/satoshilabs/slips/blob/master/slip-0044.md)

- **Fast API**: Built with Fastify for high performance
- **Indexed Data**: Efficient querying with indexed chain data
- **Search Capabilities**: Search chains by name, ID, or other attributes
- **RESTful Endpoints**: Clean and intuitive API design
- **Chain Relations & Tags**: Automatic indexing of chain relationships and tags
  - Tags: `Testnet`, `L2`, `Beacon`
  - Relations: `testnetOf`, `l2Of`, `beaconOf` with resolved chain IDs
  - Example: Base Sepolia (84532) is tagged as `Testnet` and `L2`, with relations to Base (8453) and Sepolia (11155111)

## Installation

```bash
npm install
```

## Usage

### Start the server

```bash
npm start
```

The server will start on `http://localhost:3000` by default.

### Development mode (with auto-reload)

```bash
npm run dev
```

## Environment Variables

- `PORT`: Server port (default: 3000)
- `HOST`: Server host (default: 0.0.0.0)

## API Endpoints

### `GET /`
Get API information and available endpoints.

**Response:**
```json
{
  "name": "Chains API",
  "version": "1.0.0",
  "description": "API query service for blockchain chain data from multiple sources",
  "endpoints": { ... },
  "dataSources": [ ... ]
}
```

### `GET /health`
Health check and data status.

**Response:**
```json
{
  "status": "ok",
  "dataLoaded": true,
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "totalChains": 1234
}
```

### `GET /chains`
Get all indexed chains.

**Query Parameters:**
- `tag` (optional): Filter chains by tag (e.g., `Testnet`, `L2`, `Beacon`)

**Example:** `GET /chains?tag=Testnet`

**Response:**
```json
{
  "count": 1234,
  "chains": [ ... ]
}
```

**Example Response (with tags and relations):**
```json
{
  "chainId": 84532,
  "name": "Base Sepolia Testnet",
  "tags": ["Testnet", "L2"],
  "relations": [
    {
      "kind": "testnetOf",
      "network": "base",
      "chainId": 8453
    },
    {
      "kind": "l2Of",
      "network": "sepolia",
      "chainId": 11155111
    }
  ],
  "sources": ["theGraph"],
  ...
}
```

### `GET /chains/:id`
Get a specific chain by its chain ID.

**Example:** `GET /chains/1` (Ethereum Mainnet)

**Response:**
```json
{
  "chainId": 1,
  "name": "Ethereum Mainnet",
  "shortName": "eth",
  "network": "mainnet",
  "nativeCurrency": { ... },
  "rpc": [ ... ],
  "explorers": [ ... ],
  "sources": ["chains", "chainlist", "theGraph"]
}
```

### `GET /search?q={query}`
Search chains by name or ID.

**Example:** `GET /search?q=ethereum`

**Response:**
```json
{
  "query": "ethereum",
  "count": 15,
  "results": [ ... ]
}
```

### `GET /sources`
Get status of data sources.

**Response:**
```json
{
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "sources": {
    "theGraph": "loaded",
    "chainlist": "loaded",
    "chains": "loaded",
    "slip44": "loaded"
  }
}
```

### `GET /slip44`
Get all SLIP-0044 coin types as JSON. The table from the markdown file is converted to JSON format using "Coin type" as the key (id).

**Response:**
```json
{
  "count": 1279,
  "coinTypes": {
    "0": {
      "coinType": 0,
      "pathComponent": "0x80000000",
      "symbol": "BTC",
      "coin": "Bitcoin"
    },
    "60": {
      "coinType": 60,
      "pathComponent": "0x8000003c",
      "symbol": "ETH",
      "coin": "Ether"
    }
  }
}
```

### `GET /slip44/:coinType`
Get a specific SLIP-0044 coin type by its coin type ID.

**Example:** `GET /slip44/60` (Ethereum)

**Response:**
```json
{
  "coinType": 60,
  "pathComponent": "0x8000003c",
  "symbol": "ETH",
  "coin": "Ether"
}
```

### `POST /reload`
Reload data from all sources.

**Response:**
```json
{
  "status": "success",
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "totalChains": 1234
}
```

## Data Structure

Each chain object contains:

- `chainId`: The chain ID (extracted from caip2Id for The Graph data)
- `name`: Full name of the chain
- `shortName`: Short name/symbol
- `network`: Network type (mainnet, testnet, etc.)
- `nativeCurrency`: Native currency information
- `rpc`: Array of RPC endpoints
- `explorers`: Array of block explorers
- `infoURL`: Information URL
- `sources`: Array of data sources that provided this chain's data
- `status`: Chain status (if available from data sources)
- `tags`: Array of tags (e.g., "Testnet", "L2", "Beacon")
- `relations`: Array of relations to other chains
  - Each relation contains: `kind`, `network` (network ID), optionally `chainId` (resolved chain ID), and `source` (data source)
  - Relation kinds: `testnetOf`, `l2Of`, `beaconOf`
  - Relation sources: `theGraph`, `chains`, `chainlist`
  - **chains.json relations**: When `slip44 === 1`, finds mainnet by matching `chain` field value with chains where `slip44 !== 1`
  - **chainlist relations**: When `slip44 === 1` or `isTestnet === true`, finds mainnet by matching `tvl` field value with chains where `isTestnet === false`
    - Note: `tvl` matching is based on chainlist data structure; this field may represent a chain identifier rather than Total Value Locked in some contexts
- `theGraph`: The Graph specific data (if available)
  - `id`: The Graph network identifier
  - `fullName`: Full network name
  - `caip2Id`: CAIP-2 identifier (e.g., "eip155:1")
  - `aliases`: Alternative names
  - `networkType`: Network type
  - `services`: The Graph services (firehose, substreams, etc.)
  - `nativeToken`: Native token symbol
- `slip44Info`: SLIP-0044 coin type information (if available)

## SLIP-0044 Data Structure

Each SLIP-0044 coin type object contains:

- `coinType`: The coin type number (used as the key/id)
- `pathComponent`: BIP-0044 path component in hexadecimal
- `symbol`: Coin symbol
- `coin`: Full coin name

## License

ISC