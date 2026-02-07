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

**Response:**
```json
{
  "count": 1234,
  "chains": [ ... ]
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

- `chainId`: The chain ID
- `name`: Full name of the chain
- `shortName`: Short name/symbol
- `network`: Network type (mainnet, testnet, etc.)
- `nativeCurrency`: Native currency information
- `rpc`: Array of RPC endpoints
- `explorers`: Array of block explorers
- `infoURL`: Information URL
- `sources`: Array of data sources that provided this chain's data
- `theGraph`: The Graph specific data (if available)
- `slip44Info`: SLIP-0044 coin type information (if available)

## License

ISC