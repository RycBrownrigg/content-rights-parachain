#!/usr/bin/env node
import { ApiPromise, WsProvider } from '@polkadot/api';

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:8943') });

  // Get the metadata to find pallet indices
  const metadata = await api.rpc.state.getMetadata();
  const pallets = metadata.asLatest.pallets;

  for (const pallet of pallets) {
    const name = pallet.name.toString();
    const index = pallet.index.toNumber();
    if (name.toLowerCase().includes('ethereum') || name.toLowerCase().includes('beacon') || name.toLowerCase().includes('snowbridge')) {
      console.log(`Pallet: ${name} -> index: ${index} (0x${index.toString(16)})`);
      // List calls
      if (pallet.calls.isSome) {
        const callsTypeId = pallet.calls.unwrap().type.toNumber();
        const callType = metadata.asLatest.lookup.types[callsTypeId];
        if (callType && callType.type.def.isVariant) {
          callType.type.def.asVariant.variants.forEach((v) => {
            console.log(`  call[${v.index}]: ${v.name}`);
          });
        }
      }
    }
  }

  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
