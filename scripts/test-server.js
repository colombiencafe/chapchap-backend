#!/usr/bin/env node

/**
 * Script de test rapide du serveur
 * Vérifie que le serveur démarre correctement
 */

const http = require('http');
const { spawn } = require('child_process');

console.log('🚀 Test de démarrage du serveur ChapChap...');

// Démarrer le serveur en mode test
const server = spawn('node', ['server.js'], {
  env: { ...process.env, NODE_ENV: 'test', PORT: '3001' },
  stdio: 'pipe'
});

let serverStarted = false;
let testTimeout;

// Écouter les logs du serveur
server.stdout.on('data', (data) => {
  const output = data.toString();
  console.log('📝 Server:', output.trim());
  
  // Vérifier si le serveur a démarré
  if (output.includes('Serveur démarré') || output.includes('Server started') || output.includes('listening')) {
    serverStarted = true;
    testEndpoint();
  }
});

server.stderr.on('data', (data) => {
  console.error('❌ Erreur:', data.toString().trim());
});

server.on('close', (code) => {
  console.log(`\n🔚 Serveur fermé avec le code: ${code}`);
  if (testTimeout) clearTimeout(testTimeout);
  process.exit(code);
});

// Test de l'endpoint principal
function testEndpoint() {
  setTimeout(() => {
    console.log('\n🔍 Test de l\'endpoint principal...');
    
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: '/',
      method: 'GET',
      timeout: 5000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('✅ Réponse reçue:', response);
          
          if (response.message && response.message.includes('Chapchap')) {
            console.log('🎉 Test réussi! Le serveur fonctionne correctement.');
            console.log('✅ Votre API est prête pour le déploiement sur Render.');
          } else {
            console.log('⚠️  Réponse inattendue du serveur.');
          }
        } catch (e) {
          console.log('⚠️  Réponse non-JSON:', data);
        }
        
        // Arrêter le serveur
        server.kill('SIGTERM');
      });
    });
    
    req.on('error', (err) => {
      console.error('❌ Erreur de connexion:', err.message);
      server.kill('SIGTERM');
    });
    
    req.on('timeout', () => {
      console.error('❌ Timeout: Le serveur ne répond pas');
      req.destroy();
      server.kill('SIGTERM');
    });
    
    req.end();
  }, 2000); // Attendre 2 secondes que le serveur démarre
}

// Timeout de sécurité
testTimeout = setTimeout(() => {
  if (!serverStarted) {
    console.error('❌ Timeout: Le serveur n\'a pas démarré dans les temps');
    server.kill('SIGTERM');
  }
}, 10000); // 10 secondes max

// Gestion de l'arrêt propre
process.on('SIGINT', () => {
  console.log('\n🛑 Arrêt du test...');
  server.kill('SIGTERM');
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});