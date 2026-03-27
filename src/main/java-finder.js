
'use strict';
const path   = require('path');
const fs     = require('fs');
const { spawnSync } = require('child_process');

// Знаходить Java та перевіряє її версію
// Повертає { path, version } або null
function findJava(storedPath, log) {
  const candidates = getCandidates(storedPath);
  for (const jp of candidates) {
    if (!fs.existsSync(jp)) continue;
    const ver = getJavaVersion(jp);
    if (ver !== null) {
      if (log) log.info('[JavaFinder] found:', jp, 'version:', ver);
      return { path: jp, version: ver };
    }
  }

  // Fallback: try 'java' from PATH
  const ver = getJavaVersion('java');
  if (ver !== null) {
    if (log) log.info('[JavaFinder] found in PATH, version:', ver);
    return { path: 'java', version: ver };
  }

  return null;
}

function getJavaVersion(javaPath) {
  try {
    const r = spawnSync(javaPath, ['-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      encoding: 'utf8'
    });
    const output = (r.stdout || '') + (r.stderr || '');
    const m = output.match(/version "(\d+)[._]/);
    if (m) return parseInt(m[1]);
    // Handle "1.8.x" style (Java 8)
    const m8 = output.match(/version "1\.(\d+)/);
    if (m8) return parseInt(m8[1]);
    return null;
  } catch {
    return null;
  }
}

function getCandidates(storedPath) {
  const candidates = [];

  // 1. Stored path from settings
  if (storedPath) candidates.push(storedPath);

  // 2. JAVA_HOME
  if (process.env.JAVA_HOME) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java' + ext));
  }

  if (process.platform === 'win32') {
    // 3. Scan C:\Program Files\Java\ for any JDK/JRE
    const javaBase = 'C:\\Program Files\\Java';
    if (fs.existsSync(javaBase)) {
      try {
        const dirs = fs.readdirSync(javaBase)
          .filter(d => d.startsWith('jdk') || d.startsWith('jre'))
          .sort((a, b) => {
            // Sort by version descending (prefer newer)
            const va = extractVersion(a), vb = extractVersion(b);
            return vb - va;
          });
        for (const d of dirs) {
          candidates.push(path.join(javaBase, d, 'bin', 'java.exe'));
        }
      } catch {}
    }

    // 4. Eclipse Adoptium
    const adoptium = 'C:\\Program Files\\Eclipse Adoptium';
    if (fs.existsSync(adoptium)) {
      try {
        const dirs = fs.readdirSync(adoptium)
          .sort((a, b) => extractVersion(b) - extractVersion(a));
        for (const d of dirs) {
          candidates.push(path.join(adoptium, d, 'bin', 'java.exe'));
        }
      } catch {}
    }

    // 5. Microsoft JDK
    const ms = 'C:\\Program Files\\Microsoft';
    if (fs.existsSync(ms)) {
      try {
        const dirs = fs.readdirSync(ms).filter(d => d.startsWith('jdk'))
          .sort((a, b) => extractVersion(b) - extractVersion(a));
        for (const d of dirs) {
          candidates.push(path.join(ms, d, 'bin', 'java.exe'));
        }
      } catch {}
    }

    // 6. Zulu
    for (const base of ['C:\\Program Files\\Zulu', 'C:\\Program Files\\BellSoft\\LibericaJDK']) {
      if (fs.existsSync(base)) {
        try {
          const dirs = fs.readdirSync(base)
            .sort((a, b) => extractVersion(b) - extractVersion(a));
          for (const d of dirs) {
            candidates.push(path.join(base, d, 'bin', 'java.exe'));
          }
        } catch {}
      }
    }

    // 7. Registry-based paths (common shortcuts)
    candidates.push(
      'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
      'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
    );

  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
      '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java',
      '/usr/local/bin/java',
      '/opt/homebrew/bin/java',
    );
    // Scan /Library/Java/JavaVirtualMachines/
    const jvmBase = '/Library/Java/JavaVirtualMachines';
    if (fs.existsSync(jvmBase)) {
      try {
        const dirs = fs.readdirSync(jvmBase)
          .sort((a, b) => extractVersion(b) - extractVersion(a));
        for (const d of dirs) {
          candidates.push(path.join(jvmBase, d, 'Contents', 'Home', 'bin', 'java'));
        }
      } catch {}
    }
  } else {
    // Linux
    for (const base of ['/usr/lib/jvm', '/usr/local/lib/jvm']) {
      if (fs.existsSync(base)) {
        try {
          const dirs = fs.readdirSync(base)
            .sort((a, b) => extractVersion(b) - extractVersion(a));
          for (const d of dirs) {
            candidates.push(path.join(base, d, 'bin', 'java'));
          }
        } catch {}
      }
    }
    candidates.push('/usr/bin/java', '/usr/local/bin/java');
  }

  return [...new Set(candidates)];
}

function extractVersion(name) {
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

module.exports = { findJava, getJavaVersion, getCandidates };
