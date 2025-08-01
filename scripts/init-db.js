const db = require('../config/database');

// Script d'initialisation de la base de données
const initializeDatabase = async () => {
  try {
    console.log('🔧 Début de l\'initialisation de la base de données...');
    
    // Test de connexion
    await db.testConnection();
    
    // Initialisation des tables
    await db.initializeTables();
    
    console.log('✅ Base de données initialisée avec succès!');
    console.log('\n📋 Tables créées:');
    console.log('   - users (utilisateurs)');
    console.log('   - trips (voyages)');
    console.log('   - packages (colis)');
    console.log('   - messages (messagerie)');
    console.log('   - ratings (évaluations)');
    
    console.log('\n🚀 Vous pouvez maintenant démarrer le serveur avec: npm run dev');
    
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation:', error.message);
    console.error('\n💡 Assurez-vous que:');
    console.error('   - PostgreSQL est installé et en cours d\'exécution');
    console.error('   - La base de données "chapchap_db" existe');
    console.error('   - Les paramètres de connexion dans .env sont corrects');
    process.exit(1);
  } finally {
    // Fermer la connexion
    process.exit(0);
  }
};

// Exécuter l'initialisation
initializeDatabase();