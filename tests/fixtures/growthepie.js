// growthepie API bodies in their wire shapes (src/sources/growthepie.js), keyed by path in BODIES.

export const MASTER = {
  last_updated_utc: '2026-10-16 12:00:00',
  chains: {
    base: {
      name: 'Base', name_short: 'Base', url_key: 'base', chain_type: 'rollup', caip2: 'eip155:8453', evm_chain_id: 8453,
      deployment: 'PROD', company: 'Coinbase', technology: 'Optimistic Rollup', purpose: 'Universal (EVM)', launch_date: '2023-08-09',
      stack: { label: 'OP Stack, Superchain', url: 'https://docs.optimism.io' }, da_layer: 'Ethereum (blobs)', raas: 'Self-hosted',
      l2beat_stage: { stage: 'Stage 1', hex: '#fff' }, l2beat_id: 'base', l2beat_link: 'https://l2beat.com/scaling/projects/base',
      block_explorers: { Basescan: 'https://basescan.org' }, supported_metrics: ['txcount', 'daa'], ecosystem: ['all-chains']
    },
    starknet: { name: 'Starknet', url_key: 'starknet', evm_chain_id: null, l2beat_stage: 'Stage 1' },
    all_l2s: { name: 'All L2s', url_key: 'all-l2s' },
    ethereum: { name: 'Ethereum Mainnet', url_key: 'ethereum', evm_chain_id: 1 }
  },
  metrics: { daa: { name: 'Active Addresses', category: 'activity', metric_keys: ['daa'], all_l2s_aggregate: 'sum', url_path: '/fundamentals/daily-active-addresses' } },
  blockspace_categories: { main_categories: { finance: 'Finance', social: 'Social' } }
};

const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const DATES = days('2026-08-17', 61); // ... 2026-10-16
export const FUNDAMENTALS = [
  ...DATES.map((date, i) => ({ metric_key: 'txcount', origin_key: 'base', date, value: 1000 + i * 10 })),
  ...DATES.map((date, i) => ({ metric_key: 'daa', origin_key: 'base', date, value: 500 + i })),
  ...DATES.map((date, i) => ({ metric_key: 'txcount', origin_key: 'starknet', date, value: 100 + i })),
  { metric_key: 'txcount', origin_key: 'base', date: 'not-a-date', value: 1 },
  { metric_key: 'txcount', origin_key: 'base', date: '2026-10-16', value: 'x' },
  { metric_key: 'daa', origin_key: 'ethereum', date: '2026-10-16', value: 400000 }
];
export const FEES = {
  chain_data: {
    base: {
      hourly: {
        txcosts_median: { types: ['unix', 'value_eth', 'value_usd', 'normalized'], data: [[1792159200000, 7e-7, 0.0018, 0.7], [1792155600000, 6e-7, 0.0015, 0.1]] },
        tps: { types: ['unix', 'value', 'normalized'], data: [[1792155600000, 140, 0.2], [1792159200000, 156, 0.5]] }
      }
    }
  }
};
export const LANDING = {
  data: {
    metrics: { table_visual: { base: { users: 1434291, user_share: 0.0952, cross_chain_activity: 0.1, ranking: { txcount: { rank: 1, out_of: 26 }, tvl: { rank: 1, out_of: 26 } } } } },
    all_l2s: { metrics: {
      txcount: { daily: { types: ['unix', 'value'], data: [[1792022400000, 27795156.71], [1791936000000, 27000000]] } },
      rent_paid: { daily: { types: ['unix', 'usd', 'eth'], data: [[1792022400000, 1946.96, 0.78]] } }
    } }
  }
};
export const ECONOMICS = {
  data: { chain_breakdown: { base: {
    '30d': {
      revenue: { types: ['usd', 'eth'], total: [2927063.9, 1121.5] },
      costs: { types: ['usd', 'eth'], total: [18899.9, 7.2], costs_l1: [15822.1, 6.0], costs_blobs: [3077.8, 1.2] },
      profit: { types: ['usd', 'eth'], total: [2908164, 1114.4] },
      profit_margin: { types: ['percentage'], total: [0.9936] },
      size: { types: ['bytes'], total: [38318000991] }
    },
    daily: { ignored: true }
  } } }
};
export const BLOCKSPACE = {
  data: { chains: { base: { overview: {
    types: ['gas_fees_eth_absolute', 'gas_fees_usd_absolute', 'txcount_absolute', 'gas_fees_share_eth', 'gas_fees_share_usd', 'txcount_share'],
    '30d': { finance: { data: [100, 250000, 90000000, 0.4, 0.41, 0.35] }, social: { data: [4.1, 10888, 3119172, 0.0037, 0.0037, 0.012] } },
    '7d': { finance: { data: [20, 50000, 20000000, 0.4, 0.4, 0.36] } }
  } } } }
};
export const DA = {
  last_updated_utc: '2026-10-16',
  data: {
    all_da: { top_da_consumers: { '30d': { types: ['da_consumer_key', 'name', 'da_layer', 'origin_key', 'data_posted'], data: [['base', 'Base', 'NA', 'base', 38318000991]] } } },
    da_breakdown: {
      da_ethereum_blobs: { '30d': {
        fees: { types: ['usd', 'eth'], total: [9306.7, 3.52] }, size: { types: ['bytes'], total: [114803381802] },
        fees_per_mb: { types: ['usd', 'eth'], total: [0.085, 0.00003] },
        da_consumers: { count: 42, chains: { types: ['da_consumer_key', 'name', 'gtp_origin_key'], values: [['base', 'Base', 'base'], ['blast', 'Blast', null]] } }
      } },
      totals: { '30d': {} }
    }
  }
};
export const ETH_SUPPLY = {
  data: {
    chart: {
      eth_supply: { daily: { types: ['unix', 'value'], data: [[1792022400000, 122132000], [1792108800000, 122132893.75]] } },
      eth_issuance_rate: { daily: { types: ['unix', 'value'], data: [[1792108800000, 0.0072]] } }
    },
    events: [{ date: '2015-07-30', type: 'Issuance Change', title: 'Genesis Block', issuance: '5 ETH per Block', description: 'Start.', source: 'https://blog.ethereum.org' }]
  }
};

export const BODIES = {
  'master.json': MASTER, 'fundamentals.json': FUNDAMENTALS, 'fees/table.json': FEES, 'landing_page.json': LANDING,
  'economics.json': ECONOMICS, 'blockspace/overview.json': BLOCKSPACE, 'da_overview.json': DA, 'eim/eth_supply.json': ETH_SUPPLY
};
