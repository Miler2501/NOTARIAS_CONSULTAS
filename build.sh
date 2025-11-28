#!/bin/bash
# Script de build para Render

echo "📦 Instalando dependencias de npm..."
npm install

echo "🌐 Instalando Chrome para Puppeteer..."
npx puppeteer browsers install chrome

echo "✅ Build completado"
