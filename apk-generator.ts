import { createHash } from 'node:crypto';

// Precomputed CRC-32 Table for standard IEEE 802.3 checksums
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
  }
  crc32Table[i] = c >>> 0;
}

function calculateCrc32(buf: Buffer): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

/** Base64 SHA-256 of an entry's bytes — the value a JAR manifest expects. */
function sha256Digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('base64');
}

/**
 * Build a minimal, structurally valid APK-shaped ZIP for local simulation.
 *
 * The container is real: local headers, central directory, EOCD and CRC-32s all
 * check out, and the `META-INF/MANIFEST.MF` digests below are the entries' true
 * SHA-256 values rather than the placeholder text that used to sit there.
 *
 * What it is *not* is signed. There is no `META-INF/*.SF`/`*.RSA` signature
 * block, so Android will refuse to install it — deliberately: this stands in for
 * "the build produced a file" so the artifact path can be exercised offline, and
 * a real, installable APK has to come out of the sandbox's own toolchain.
 */
export function generateStandaloneApkBuffer(appName = 'HelloApp', packageName = 'com.awaiscodex.app'): Buffer {
  // A minimal valid ZIP archive containing AndroidManifest.xml and DEX headers
  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}"
    android:versionCode="1"
    android:versionName="1.0">
    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
    <application
        android:label="${appName}"
        android:theme="@android:style/Theme.DeviceDefault.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  const manifestBuf = Buffer.from(manifestXml, 'utf-8');
  const dummyDex = Buffer.from([
    0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00,
    0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00
  ]);
  const metaInfMf = Buffer.from(
    [
      'Manifest-Version: 1.0',
      'Created-By: Awais Codex Antigravity Build Tool',
      '',
      'Name: AndroidManifest.xml',
      `SHA-256-Digest: ${sha256Digest(manifestBuf)}`,
      '',
      'Name: classes.dex',
      `SHA-256-Digest: ${sha256Digest(dummyDex)}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  // Build a standard single-file or multi-file ZIP container with valid CRC32
  function createZipEntry(filename: string, content: Buffer, offset: number) {
    const fnBuf = Buffer.from(filename, 'utf-8');
    const crc = calculateCrc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // Local file header signature
    header.writeUInt16LE(20, 4);        // Version needed to extract
    header.writeUInt16LE(0, 6);         // General purpose bit flag
    header.writeUInt16LE(0, 8);         // Compression method (0 = store)
    header.writeUInt16LE(0x546b, 10);   // File last mod time
    header.writeUInt16LE(0x5ca9, 12);   // File last mod date
    header.writeUInt32LE(crc, 14);      // Real CRC-32
    header.writeUInt32LE(content.length, 18); // Compressed size
    header.writeUInt32LE(content.length, 22); // Uncompressed size
    header.writeUInt16LE(fnBuf.length, 26);  // Filename length
    header.writeUInt16LE(0, 28);             // Extra field length

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory header
    cdHeader.writeUInt16LE(20, 4);         // Version made by
    cdHeader.writeUInt16LE(20, 6);         // Version needed to extract
    cdHeader.writeUInt16LE(0, 8);          // General purpose bit flag
    cdHeader.writeUInt16LE(0, 10);         // Compression method (0 = store)
    cdHeader.writeUInt16LE(0x546b, 12);    // File last mod time
    cdHeader.writeUInt16LE(0x5ca9, 14);    // File last mod date
    cdHeader.writeUInt32LE(crc, 16);       // Real CRC-32
    cdHeader.writeUInt32LE(content.length, 20); // Compressed size
    cdHeader.writeUInt32LE(content.length, 24); // Uncompressed size
    cdHeader.writeUInt16LE(fnBuf.length, 28);   // Filename length
    cdHeader.writeUInt16LE(0, 30);              // Extra field length
    cdHeader.writeUInt16LE(0, 32);              // File comment length
    cdHeader.writeUInt16LE(0, 34);              // Disk number start
    cdHeader.writeUInt16LE(0, 36);              // Internal file attributes
    cdHeader.writeUInt32LE(0, 38);              // External file attributes
    cdHeader.writeUInt32LE(offset, 42);         // Relative offset of local header

    const localChunk = Buffer.concat([header, fnBuf, content]);
    const cdChunk = Buffer.concat([cdHeader, fnBuf]);
    return { localChunk, cdChunk };
  }

  const files = [
    { name: 'AndroidManifest.xml', content: manifestBuf },
    { name: 'classes.dex', content: dummyDex },
    { name: 'META-INF/MANIFEST.MF', content: metaInfMf }
  ];

  let offset = 0;
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];

  for (const f of files) {
    const entry = createZipEntry(f.name, f.content, offset);
    localChunks.push(entry.localChunk);
    cdChunks.push(entry.cdChunk);
    offset += entry.localChunk.length;
  }

  const cdStart = offset;
  const cdBuffer = Buffer.concat(cdChunks);
  const cdSize = cdBuffer.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central dir signature
  eocd.writeUInt16LE(0, 4);          // Number of this disk
  eocd.writeUInt16LE(0, 6);          // Disk with start of CD
  eocd.writeUInt16LE(files.length, 8); // Entries in CD on this disk
  eocd.writeUInt16LE(files.length, 10); // Total entries in CD
  eocd.writeUInt32LE(cdSize, 12);    // Size of central directory
  eocd.writeUInt32LE(cdStart, 16);   // Offset of start of CD
  eocd.writeUInt16LE(0, 20);         // Comment length

  return Buffer.concat([...localChunks, cdBuffer, eocd]);
}
