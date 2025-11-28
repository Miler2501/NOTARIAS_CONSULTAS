#!/bin/bash
# Script de build para Render

echo "📦 Instalando dependencias de npm..."
npm install

echo "🌐 Instalando Chrome en directorio local..."
mkdir -p .cache/puppeteer
PUPPETEER_CACHE_DIR=./.cache/puppeteer npx puppeteer browsers install chrome

echo "✅ Build completado"
