// A small chain registry for tests that need to know which words name test networks
// (src/domain/networkWords.js learns them from the registry, as production does).
const test = (chainId, name, extra = {}) => ({ chainId, name, tags: ['Testnet'], ...extra });
const main = (chainId, name, extra = {}) => ({ chainId, name, tags: [], ...extra });

export const TESTNET_REGISTRY = [
  main(1, 'Ethereum Mainnet', { 'theGraph-id': 'mainnet' }),
  main(8453, 'Base'),
  main(10, 'OP Mainnet'),
  main(56, 'BNB Smart Chain Mainnet', { aliases: ['bsc', 'bnb'] }),
  test(11155111, 'Ethereum Sepolia', { 'theGraph-id': 'sepolia' }),
  test(84532, 'Base Sepolia Testnet'),
  test(11155420, 'OP Sepolia Testnet'),
  test(560048, 'Ethereum Hoodi', { 'theGraph-id': 'hoodi' }),
  test(374, 'Status Network Hoodi'),
  test(2910, 'Morph Hoodi'),
  test(17000, 'Ethereum Holesky', { 'theGraph-id': 'holesky' }),
  test(2522, 'Fraxtal Holesky Testnet'),
  test(4801, 'World Chain Holesky'),
  test(97, 'BNB Smart Chain Testnet', { 'theGraph-id': 'chapel', aliases: ['bnb-chapel', 'bsc-testnet'] }),
  test(80002, 'Amoy', { 'theGraph-id': 'polygon-amoy' }),
  test(43113, 'Avalanche Fuji Testnet', { aliases: ['avalanche-fuji'] })
];
