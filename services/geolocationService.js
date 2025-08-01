const socketService = require('./socketService');
const db = require('../config/database');

/**
 * Service de géolocalisation pour ChapChap
 * Suivi en temps réel des voyageurs pendant le trajet
 */
class GeolocationService {
  constructor() {
    this.activeTracking = new Map(); // userId -> trackingData
    this.trackingIntervals = new Map(); // userId -> intervalId
  }

  /**
   * Démarrer le suivi de géolocalisation pour un voyage
   * @param {number} userId - ID du voyageur
   * @param {number} tripId - ID du voyage
   * @param {Object} options - Options de suivi
   */
  async startTracking(userId, tripId, options = {}) {
    try {
      const {
        updateInterval = 30000, // 30 secondes par défaut
        accuracy = 'high',
        shareWithSenders = true
      } = options;

      // Vérifier que le voyage existe et appartient à l'utilisateur
      const tripQuery = `
        SELECT id, departure_city, destination_city, departure_date, status
        FROM trips 
        WHERE id = $1 AND traveler_id = $2 AND status IN ('active', 'in_progress')
      `;
      
      const tripResult = await db.query(tripQuery, [tripId, userId]);
      
      if (tripResult.rows.length === 0) {
        throw new Error('Voyage non trouvé ou non autorisé pour le suivi');
      }

      const trip = tripResult.rows[0];

      // Créer l'enregistrement de suivi
      const trackingData = {
        userId,
        tripId,
        startTime: new Date(),
        updateInterval,
        accuracy,
        shareWithSenders,
        isActive: true,
        lastUpdate: null,
        currentLocation: null,
        trip
      };

      this.activeTracking.set(userId.toString(), trackingData);

      // Enregistrer en base de données
      const insertQuery = `
        INSERT INTO trip_tracking (trip_id, traveler_id, start_time, update_interval, accuracy, share_with_senders, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'active')
        RETURNING id
      `;
      
      const result = await db.query(insertQuery, [
        tripId, userId, trackingData.startTime, updateInterval, accuracy, shareWithSenders
      ]);

      trackingData.trackingId = result.rows[0].id;

      // Notifier les expéditeurs concernés si autorisé
      if (shareWithSenders) {
        await this.notifyTrackingStarted(tripId, userId);
      }

      console.log(`Suivi géolocalisation démarré pour l'utilisateur ${userId}, voyage ${tripId}`);
      
      return {
        success: true,
        message: 'Suivi de géolocalisation démarré',
        trackingId: trackingData.trackingId,
        updateInterval
      };

    } catch (error) {
      console.error('Erreur lors du démarrage du suivi:', error);
      throw error;
    }
  }

  /**
   * Mettre à jour la position du voyageur
   * @param {number} userId - ID du voyageur
   * @param {Object} location - Données de localisation
   */
  async updateLocation(userId, location) {
    try {
      const {
        latitude,
        longitude,
        accuracy,
        speed,
        heading,
        timestamp
      } = location;

      const trackingData = this.activeTracking.get(userId.toString());
      
      if (!trackingData || !trackingData.isActive) {
        throw new Error('Aucun suivi actif pour cet utilisateur');
      }

      // Valider les coordonnées
      if (!this.isValidCoordinate(latitude, longitude)) {
        throw new Error('Coordonnées invalides');
      }

      const locationData = {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy: accuracy || null,
        speed: speed || null,
        heading: heading || null,
        timestamp: timestamp || new Date().toISOString()
      };

      // Mettre à jour les données de suivi
      trackingData.currentLocation = locationData;
      trackingData.lastUpdate = new Date();

      // Enregistrer en base de données
      const insertQuery = `
        INSERT INTO trip_locations (tracking_id, latitude, longitude, accuracy, speed, heading, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      
      await db.query(insertQuery, [
        trackingData.trackingId,
        locationData.latitude,
        locationData.longitude,
        locationData.accuracy,
        locationData.speed,
        locationData.heading,
        locationData.timestamp
      ]);

      // Notifier en temps réel si autorisé
      if (trackingData.shareWithSenders) {
        await this.broadcastLocationUpdate(trackingData.tripId, userId, locationData);
      }

      return {
        success: true,
        message: 'Position mise à jour',
        location: locationData
      };

    } catch (error) {
      console.error('Erreur lors de la mise à jour de position:', error);
      throw error;
    }
  }

  /**
   * Arrêter le suivi de géolocalisation
   * @param {number} userId - ID du voyageur
   */
  async stopTracking(userId) {
    try {
      const trackingData = this.activeTracking.get(userId.toString());
      
      if (!trackingData) {
        throw new Error('Aucun suivi actif pour cet utilisateur');
      }

      // Marquer comme inactif
      trackingData.isActive = false;
      trackingData.endTime = new Date();

      // Mettre à jour en base de données
      const updateQuery = `
        UPDATE trip_tracking 
        SET status = 'completed', end_time = $1
        WHERE id = $2
      `;
      
      await db.query(updateQuery, [trackingData.endTime, trackingData.trackingId]);

      // Supprimer du cache
      this.activeTracking.delete(userId.toString());

      // Nettoyer l'intervalle s'il existe
      if (this.trackingIntervals.has(userId.toString())) {
        clearInterval(this.trackingIntervals.get(userId.toString()));
        this.trackingIntervals.delete(userId.toString());
      }

      // Notifier la fin du suivi
      await this.notifyTrackingStopped(trackingData.tripId, userId);

      console.log(`Suivi géolocalisation arrêté pour l'utilisateur ${userId}`);
      
      return {
        success: true,
        message: 'Suivi de géolocalisation arrêté'
      };

    } catch (error) {
      console.error('Erreur lors de l\'arrêt du suivi:', error);
      throw error;
    }
  }

  /**
   * Obtenir la position actuelle d'un voyageur
   * @param {number} tripId - ID du voyage
   * @param {number} requesterId - ID de l'utilisateur qui demande
   */
  async getCurrentLocation(tripId, requesterId) {
    try {
      // Vérifier les permissions
      const hasPermission = await this.checkLocationPermission(tripId, requesterId);
      
      if (!hasPermission) {
        throw new Error('Permission refusée pour accéder à la localisation');
      }

      // Récupérer la dernière position
      const locationQuery = `
        SELECT 
          tl.latitude, tl.longitude, tl.accuracy, tl.speed, tl.heading, tl.recorded_at,
          tt.traveler_id, tt.share_with_senders
        FROM trip_locations tl
        JOIN trip_tracking tt ON tl.tracking_id = tt.id
        WHERE tt.trip_id = $1 AND tt.status = 'active'
        ORDER BY tl.recorded_at DESC
        LIMIT 1
      `;
      
      const result = await db.query(locationQuery, [tripId]);
      
      if (result.rows.length === 0) {
        return {
          success: false,
          message: 'Aucune localisation disponible pour ce voyage'
        };
      }

      const location = result.rows[0];
      
      return {
        success: true,
        data: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy,
          speed: location.speed,
          heading: location.heading,
          timestamp: location.recorded_at,
          travelerId: location.traveler_id
        }
      };

    } catch (error) {
      console.error('Erreur lors de la récupération de position:', error);
      throw error;
    }
  }

  /**
   * Obtenir l'historique de trajet
   * @param {number} tripId - ID du voyage
   * @param {number} requesterId - ID de l'utilisateur qui demande
   */
  async getTripHistory(tripId, requesterId) {
    try {
      // Vérifier les permissions
      const hasPermission = await this.checkLocationPermission(tripId, requesterId);
      
      if (!hasPermission) {
        throw new Error('Permission refusée pour accéder à l\'historique');
      }

      const historyQuery = `
        SELECT 
          tl.latitude, tl.longitude, tl.accuracy, tl.speed, tl.heading, tl.recorded_at
        FROM trip_locations tl
        JOIN trip_tracking tt ON tl.tracking_id = tt.id
        WHERE tt.trip_id = $1
        ORDER BY tl.recorded_at ASC
      `;
      
      const result = await db.query(historyQuery, [tripId]);
      
      return {
        success: true,
        data: {
          tripId,
          locations: result.rows,
          totalPoints: result.rows.length
        }
      };

    } catch (error) {
      console.error('Erreur lors de la récupération de l\'historique:', error);
      throw error;
    }
  }

  /**
   * Vérifier les permissions d'accès à la localisation
   * @param {number} tripId - ID du voyage
   * @param {number} userId - ID de l'utilisateur
   */
  async checkLocationPermission(tripId, userId) {
    try {
      const permissionQuery = `
        SELECT 
          t.traveler_id,
          tt.share_with_senders,
          CASE 
            WHEN t.traveler_id = $2 THEN true
            WHEN tt.share_with_senders = true AND EXISTS (
              SELECT 1 FROM packages p WHERE p.trip_id = $1 AND p.sender_id = $2
            ) THEN true
            ELSE false
          END as has_permission
        FROM trips t
        LEFT JOIN trip_tracking tt ON t.id = tt.trip_id AND tt.status = 'active'
        WHERE t.id = $1
      `;
      
      const result = await db.query(permissionQuery, [tripId, userId]);
      
      if (result.rows.length === 0) {
        return false;
      }

      return result.rows[0].has_permission;

    } catch (error) {
      console.error('Erreur lors de la vérification des permissions:', error);
      return false;
    }
  }

  /**
   * Valider les coordonnées GPS
   * @param {number} latitude - Latitude
   * @param {number} longitude - Longitude
   */
  isValidCoordinate(latitude, longitude) {
    return (
      typeof latitude === 'number' &&
      typeof longitude === 'number' &&
      latitude >= -90 && latitude <= 90 &&
      longitude >= -180 && longitude <= 180
    );
  }

  /**
   * Notifier le début du suivi
   * @param {number} tripId - ID du voyage
   * @param {number} travelerId - ID du voyageur
   */
  async notifyTrackingStarted(tripId, travelerId) {
    try {
      // Récupérer les expéditeurs concernés
      const sendersQuery = `
        SELECT DISTINCT p.sender_id
        FROM packages p
        WHERE p.trip_id = $1 AND p.status NOT IN ('delivered', 'cancelled')
      `;
      
      const result = await db.query(sendersQuery, [tripId]);
      
      const notification = {
        type: 'tracking_started',
        tripId,
        travelerId,
        message: 'Le suivi en temps réel de votre colis a commencé',
        timestamp: new Date().toISOString()
      };

      // Notifier via Socket.IO
      if (socketService) {
        socketService.io.to(`trip_${tripId}`).emit('tracking_started', notification);
        
        result.rows.forEach(row => {
          socketService.io.to(`user_${row.sender_id}`).emit('tracking_notification', notification);
        });
      }

    } catch (error) {
      console.error('Erreur lors de la notification de début:', error);
    }
  }

  /**
   * Diffuser une mise à jour de position
   * @param {number} tripId - ID du voyage
   * @param {number} travelerId - ID du voyageur
   * @param {Object} location - Données de localisation
   */
  async broadcastLocationUpdate(tripId, travelerId, location) {
    try {
      const notification = {
        type: 'location_update',
        tripId,
        travelerId,
        location,
        timestamp: new Date().toISOString()
      };

      // Diffuser via Socket.IO
      if (socketService) {
        socketService.io.to(`trip_${tripId}`).emit('location_updated', notification);
      }

    } catch (error) {
      console.error('Erreur lors de la diffusion de position:', error);
    }
  }

  /**
   * Notifier la fin du suivi
   * @param {number} tripId - ID du voyage
   * @param {number} travelerId - ID du voyageur
   */
  async notifyTrackingStopped(tripId, travelerId) {
    try {
      const notification = {
        type: 'tracking_stopped',
        tripId,
        travelerId,
        message: 'Le suivi en temps réel s\'est arrêté',
        timestamp: new Date().toISOString()
      };

      // Notifier via Socket.IO
      if (socketService) {
        socketService.io.to(`trip_${tripId}`).emit('tracking_stopped', notification);
      }

    } catch (error) {
      console.error('Erreur lors de la notification de fin:', error);
    }
  }

  /**
   * Obtenir les statistiques de suivi
   * @param {number} userId - ID de l'utilisateur
   */
  async getTrackingStats(userId) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_trips_tracked,
          COUNT(CASE WHEN tt.status = 'active' THEN 1 END) as active_tracking,
          AVG(EXTRACT(EPOCH FROM (tt.end_time - tt.start_time))/3600) as avg_tracking_hours,
          COUNT(DISTINCT tl.id) as total_location_points
        FROM trip_tracking tt
        LEFT JOIN trip_locations tl ON tt.id = tl.tracking_id
        WHERE tt.traveler_id = $1
      `;
      
      const result = await db.query(statsQuery, [userId]);
      
      return {
        success: true,
        data: result.rows[0]
      };

    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques:', error);
      throw error;
    }
  }

  /**
   * Nettoyer les suivis inactifs
   */
  async cleanupInactiveTracking() {
    try {
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h
      
      const cleanupQuery = `
        UPDATE trip_tracking 
        SET status = 'expired'
        WHERE status = 'active' 
          AND start_time < $1
          AND NOT EXISTS (
            SELECT 1 FROM trip_locations tl 
            WHERE tl.tracking_id = trip_tracking.id 
              AND tl.recorded_at > $1
          )
      `;
      
      const result = await db.query(cleanupQuery, [cutoffTime]);
      
      console.log(`${result.rowCount} suivis inactifs nettoyés`);
      
      return result.rowCount;

    } catch (error) {
      console.error('Erreur lors du nettoyage:', error);
      return 0;
    }
  }
}

// Instance singleton
const geolocationService = new GeolocationService();

// Nettoyage automatique toutes les heures
setInterval(() => {
  geolocationService.cleanupInactiveTracking();
}, 60 * 60 * 1000);

module.exports = geolocationService;