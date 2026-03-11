#!/usr/bin/env tsx
/**
 * Run migrations against the schema explorer database
 *
 * Usage:
 *   pnpm tsx scripts/explorer-migrate.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { runMigrations } from '../packages/sync-engine/src/database/migrate.js';

const TMP_DIR = path.join(process.cwd(), '.tmp');
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json');

interface ContainerMetadata {
  databaseUrl: string;
  containerId: string;
  containerName: string;
  port: number;
  volumeName: string;
  createdAt: string;
}

async function main(): Promise<void> {
  console.log('🔧 Explorer Migration Script\n');

  // Load metadata
  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ Error: No metadata file found');
    console.error(`   Expected: ${METADATA_FILE}`);
    console.error('\n💡 Start the harness first: pnpm explorer:db:start');
    process.exit(1);
  }

  const metadata: ContainerMetadata = JSON.parse(
    fs.readFileSync(METADATA_FILE, 'utf-8')
  );

  console.log('📋 Connection details:');
  console.log(`   Database URL: ${metadata.databaseUrl}`);
  console.log(`   Container: ${metadata.containerName}`);
  console.log('');

  console.log('🚀 Running migrations...\n');

  try {
    await runMigrations({
      databaseUrl: metadata.databaseUrl,
      logger: {
        info: (msg: any) => console.log('  ℹ️ ', typeof msg === 'string' ? msg : JSON.stringify(msg)),
        warn: (msg: any) => console.log('  ⚠️ ', typeof msg === 'string' ? msg : JSON.stringify(msg)),
        error: (msg: any) => console.log('  ❌', typeof msg === 'string' ? msg : JSON.stringify(msg)),
      },
      tableMode: 'runtime_required', // Use runtime_required mode as specified
    });

    console.log('\n✅ Migrations complete!');
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
