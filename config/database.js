const { Pool } = require('pg');
require('dotenv').config();

// Configuration de la connexion PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'chapchap_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20, // nombre maximum de clients dans le pool
  idleTimeoutMillis: 30000, // temps d'attente avant fermeture d'une connexion inactive
  connectionTimeoutMillis: 2000, // temps d'attente pour établir une connexion
});

// Fonction pour tester la connexion
const testConnection = async () => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('🔗 Test de connexion PostgreSQL réussi:', result.rows[0].now);
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Erreur de connexion PostgreSQL:', error.message);
    throw error;
  }
};

// Fonction pour exécuter une requête
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('📊 Requête exécutée:', { text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    console.error('❌ Erreur lors de l\'exécution de la requête:', error.message);
    throw error;
  }
};

// Fonction pour obtenir un client du pool (pour les transactions)
const getClient = async () => {
  try {
    const client = await pool.connect();
    return client;
  } catch (error) {
    console.error('❌ Erreur lors de l\'obtention du client:', error.message);
    throw error;
  }
};

// Fonction pour initialiser les tables de la base de données
const initializeTables = async () => {
  try {
    console.log('🔧 Initialisation des tables de la base de données...');
    
    // Table des utilisateurs
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        profile_picture TEXT,
        user_type VARCHAR(20) CHECK (user_type IN ('traveler', 'sender', 'both')) DEFAULT 'both',
        is_verified BOOLEAN DEFAULT FALSE,
        rating DECIMAL(3,2) DEFAULT 0.00,
        total_ratings INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table des voyages
    await query(`
      CREATE TABLE IF NOT EXISTS trips (
        id SERIAL PRIMARY KEY,
        traveler_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        departure_country VARCHAR(100) NOT NULL,
        departure_city VARCHAR(100) NOT NULL,
        destination_country VARCHAR(100) NOT NULL,
        destination_city VARCHAR(100) NOT NULL,
        departure_date DATE NOT NULL,
        arrival_date DATE,
        available_weight DECIMAL(5,2) NOT NULL,
        price_per_kg DECIMAL(8,2) NOT NULL,
        description TEXT,
        status VARCHAR(20) CHECK (status IN ('active', 'completed', 'cancelled')) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table des colis
    await query(`
      CREATE TABLE IF NOT EXISTS packages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        weight DECIMAL(5,2) NOT NULL,
        dimensions VARCHAR(100),
        value DECIMAL(10,2),
        pickup_address TEXT NOT NULL,
        delivery_address TEXT NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) CHECK (status IN ('pending', 'accepted', 'in_transit', 'delivered', 'cancelled')) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table des messages
    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table des évaluations
    await query(`
      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        rater_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rated_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rater_id, rated_user_id, package_id)
      )
    `);
    
    // Créer la table des tokens de vérification
    await query(`
      CREATE TABLE IF NOT EXISTS verification_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(255) NOT NULL UNIQUE,
        type VARCHAR(50) NOT NULL CHECK (type IN ('email_verification', 'password_reset')),
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, type)
      )
    `);
    
    // Créer la table des documents utilisateur
    await query(`
      CREATE TABLE IF NOT EXISTS user_documents (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        document_type VARCHAR(50) NOT NULL CHECK (document_type IN ('passport', 'nationalId', 'drivingLicense')),
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        mimetype VARCHAR(100) NOT NULL,
        size INTEGER NOT NULL,
        verification_status VARCHAR(20) DEFAULT 'pending' CHECK (verification_status IN ('pending', 'approved', 'rejected', 'expired')),
        rejection_reason TEXT,
        verified_at TIMESTAMP,
        verified_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, document_type)
      )
    `);

    // Table des conversations pour organiser les messages
    await query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
        package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        traveler_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        last_message_id INTEGER REFERENCES messages(id),
        last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(trip_id, package_id, sender_id, traveler_id)
      )
    `);

    // Index pour optimiser les requêtes de messagerie
    await query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation 
      ON messages(sender_id, receiver_id, package_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
      ON messages(created_at DESC)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_participants 
      ON conversations(sender_id, traveler_id)
    `);
    
    // Table de suivi des colis
    await query(`
      CREATE TABLE IF NOT EXISTS package_tracking (
        id SERIAL PRIMARY KEY,
        package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        notes TEXT,
        location VARCHAR(255),
        photo_path VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table des litiges
    await query(`
      CREATE TABLE IF NOT EXISTS package_disputes (
        id SERIAL PRIMARY KEY,
        package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
        reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reason VARCHAR(100) NOT NULL,
        description TEXT,
        evidence_photos TEXT, -- JSON array of photo paths
        status VARCHAR(50) DEFAULT 'open',
        resolution TEXT,
        resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Index pour optimiser les requêtes de suivi
    await query(`
      CREATE INDEX IF NOT EXISTS idx_package_tracking_package 
      ON package_tracking(package_id, created_at DESC)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_package_tracking_status 
      ON package_tracking(status, created_at DESC)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_package_disputes_package 
      ON package_disputes(package_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_package_disputes_status 
      ON package_disputes(status, created_at DESC)
    `);

    // Tables pour la géolocalisation
    await query(`
      CREATE TABLE IF NOT EXISTS trip_tracking (
        id SERIAL PRIMARY KEY,
        trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
        traveler_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP,
        update_interval INTEGER DEFAULT 30000,
        accuracy VARCHAR(10) DEFAULT 'high',
        share_with_senders BOOLEAN DEFAULT true,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS trip_locations (
        id SERIAL PRIMARY KEY,
        tracking_id INTEGER REFERENCES trip_tracking(id) ON DELETE CASCADE,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        accuracy DECIMAL(8, 2),
        speed DECIMAL(8, 2),
        heading DECIMAL(5, 2),
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Index pour la géolocalisation
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trip_tracking_trip_id 
      ON trip_tracking(trip_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trip_tracking_traveler_id 
      ON trip_tracking(traveler_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trip_tracking_status 
      ON trip_tracking(status)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trip_tracking_start_time 
      ON trip_tracking(start_time)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trip_locations_tracking_id 
      ON trip_locations(tracking_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trip_locations_recorded_at 
      ON trip_locations(recorded_at)
    `);
    
    await query(`
       CREATE INDEX IF NOT EXISTS idx_trip_locations_coordinates 
       ON trip_locations(latitude, longitude)
     `);

     // Table pour les tokens FCM (notifications push)
     await query(`
       CREATE TABLE IF NOT EXISTS user_fcm_tokens (
         id SERIAL PRIMARY KEY,
         user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
         fcm_token TEXT NOT NULL,
         device_type VARCHAR(20) DEFAULT 'web',
         is_active BOOLEAN DEFAULT true,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         UNIQUE(user_id, fcm_token)
       )
     `);

     // Index pour les tokens FCM
     await query(`
       CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_user_id 
       ON user_fcm_tokens(user_id)
     `);
     
     await query(`
        CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_active 
        ON user_fcm_tokens(is_active, updated_at)
      `);

      // Table pour le suivi visuel des colis (timeline avec photos)
      await query(`
        CREATE TABLE IF NOT EXISTS package_visual_tracking (
          id SERIAL PRIMARY KEY,
          package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
          status VARCHAR(50) NOT NULL,
          description TEXT NOT NULL,
          location TEXT,
          photo_url TEXT,
          created_by INTEGER NOT NULL REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Index pour le suivi visuel
      await query(`
        CREATE INDEX IF NOT EXISTS idx_package_visual_tracking_package_id 
        ON package_visual_tracking(package_id)
      `);
      
      await query(`
        CREATE INDEX IF NOT EXISTS idx_package_visual_tracking_status 
        ON package_visual_tracking(status)
      `);
      
      await query(`
        CREATE INDEX IF NOT EXISTS idx_package_visual_tracking_created_by 
        ON package_visual_tracking(created_by)
      `);
      
      await query(`
        CREATE INDEX IF NOT EXISTS idx_package_visual_tracking_created_at 
        ON package_visual_tracking(created_at)
      `);

      // Table pour les évaluations utilisateur
      await query(`
        CREATE TABLE IF NOT EXISTS user_ratings (
          id SERIAL PRIMARY KEY,
          rater_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          rated_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment TEXT,
          rating_type VARCHAR(20) NOT NULL CHECK (rating_type IN ('sender', 'traveler')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(rater_id, rated_user_id, package_id)
        )
      `);

      // Index pour les évaluations
      await query(`
        CREATE INDEX IF NOT EXISTS idx_user_ratings_rated_user 
        ON user_ratings(rated_user_id, created_at DESC)
      `);
      
      await query(`
        CREATE INDEX IF NOT EXISTS idx_user_ratings_rater 
        ON user_ratings(rater_id, created_at DESC)
      `);
      
      await query(`
        CREATE INDEX IF NOT EXISTS idx_user_ratings_package 
        ON user_ratings(package_id)
      `);
      
      await query(`
        CREATE INDEX IF NOT EXISTS idx_user_ratings_rating 
        ON user_ratings(rating)
      `);

      // Ajouter les colonnes de préférences de notification et de statistiques d'évaluation à la table users
      await query(`
        ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS notification_packages BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS notification_trips BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS notification_messages BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS notification_location BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS notification_disputes BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS notification_marketing BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS rating_average DECIMAL(3,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0
      `);
      
      console.log('✅ Tables initialisées avec succès');
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation des tables:', error.message);
    throw error;
  }
};

// Gestion propre de la fermeture
process.on('SIGINT', () => {
  console.log('🔄 Fermeture du pool de connexions PostgreSQL...');
  pool.end(() => {
    console.log('✅ Pool de connexions fermé');
    process.exit(0);
  });
});

module.exports = {
  pool,
  query,
  getClient,
  testConnection,
  initializeTables
};