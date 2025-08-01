#!/usr/bin/env node

/**
 * Script de vérification avant déploiement
 * Vérifie que tous les fichiers et dépendances sont présents
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Vérification avant déploiement...');

// Fichiers requis
const requiredFiles = [
  'package.json',
  'server.js',
  '.env.example',
  'config/database.js',
  'middleware/auth.js',
  'routes/auth.js',
  'routes/users.js',
  'routes/trips.js',
  'routes/packages.js',
  'routes/messages.js',
  'routes/files.js',
  'services/socketService.js',
  'services/emailService.js'
];

// Dossiers requis
const requiredDirs = [
  'config',
  'middleware', 
  'routes',
  'services',
  'uploads'
];

let errors = [];

// Vérifier les fichiers
console.log('\n📁 Vérification des fichiers...');
requiredFiles.forEach(file => {
  if (!fs.existsSync(file)) {
    errors.push(`❌ Fichier manquant: ${file}`);
  } else {
    console.log(`✅ ${file}`);
  }
});

// Vérifier les dossiers
console.log('\n📂 Vérification des dossiers...');
requiredDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    errors.push(`❌ Dossier manquant: ${dir}`);
  } else {
    console.log(`✅ ${dir}/`);
  }
});

// Vérifier package.json
console.log('\n📦 Vérification de package.json...');
try {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  
  if (!pkg.scripts || !pkg.scripts.start) {
    errors.push('❌ Script "start" manquant dans package.json');
  } else {
    console.log('✅ Script "start" présent');
  }
  
  if (!pkg.engines || !pkg.engines.node) {
    errors.push('❌ Version Node.js non spécifiée dans package.json');
  } else {
    console.log(`✅ Version Node.js: ${pkg.engines.node}`);
  }
  
  // Vérifier les dépendances critiques
  const criticalDeps = ['express', 'pg', 'jsonwebtoken', 'bcryptjs'];
  criticalDeps.forEach(dep => {
    if (!pkg.dependencies || !pkg.dependencies[dep]) {
      errors.push(`❌ Dépendance critique manquante: ${dep}`);
    } else {
      console.log(`✅ ${dep}: ${pkg.dependencies[dep]}`);
    }
  });
  
} catch (e) {
  errors.push('❌ Erreur lors de la lecture de package.json');
}

// Vérifier .gitignore
console.log('\n🚫 Vérification de .gitignore...');
if (!fs.existsSync('.gitignore')) {
  errors.push('❌ Fichier .gitignore manquant');
} else {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');
  if (!gitignore.includes('node_modules')) {
    errors.push('❌ node_modules non exclu dans .gitignore');
  }
  if (!gitignore.includes('.env')) {
    errors.push('❌ .env non exclu dans .gitignore');
  }
  console.log('✅ .gitignore configuré');
}

// Résultats
console.log('\n' + '='.repeat(50));
if (errors.length === 0) {
  console.log('🎉 Tous les contrôles sont passés!');
  console.log('✅ Votre projet est prêt pour le déploiement sur Render.');
  process.exit(0);
} else {
  console.log('❌ Erreurs détectées:');
  errors.forEach(error => console.log(error));
  console.log('\n🔧 Corrigez ces erreurs avant de déployer.');
  process.exit(1);
}