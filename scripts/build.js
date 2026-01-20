#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Files to include in the extension zip
const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const MANIFEST_PATH = path.join(ROOT_DIR, 'manifest.json');

// Read version from manifest.json
function getVersion() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.version;
}

// Ensure dist directory exists
function ensureDistDir() {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
}

// Check all required files exist
function validateFiles() {
  const missing = [];
  for (const file of EXTENSION_FILES) {
    const filePath = path.join(ROOT_DIR, file);
    if (!fs.existsSync(filePath)) {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    console.error('Missing required files:', missing.join(', '));
    process.exit(1);
  }
}

// Build the zip file
function buildZip() {
  const version = getVersion();
  const zipName = `text-to-calendar-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);

  // Remove existing zip if present
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  // Create zip using system zip command
  const fileList = EXTENSION_FILES.join(' ');
  try {
    execSync(`zip -r "${zipPath}" ${fileList}`, {
      cwd: ROOT_DIR,
      stdio: 'inherit'
    });
    console.log(`\n✓ Built: dist/${zipName}`);
    return zipPath;
  } catch (error) {
    console.error('Failed to create zip:', error.message);
    process.exit(1);
  }
}

// Main
console.log('Building Text to Calendar extension...\n');
validateFiles();
ensureDistDir();
buildZip();
console.log('\nBuild complete!');
