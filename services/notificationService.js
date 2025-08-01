const admin = require('firebase-admin');
const socketService = require('./socketService');
const db = require('../config/database');

// Configuration Firebase Admin SDK (à configurer avec vos clés)
let firebaseApp = null;

try {
  // Initialiser Firebase Admin SDK si les credentials sont disponibles
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK initialisé');
  } else {
    console.log('⚠️ Firebase Admin SDK non configuré - notifications push désactivées');
  }
} catch (error) {
  console.error('❌ Erreur lors de l\'initialisation de Firebase:', error.message);
}

class NotificationService {
  constructor() {
    this.messaging = firebaseApp ? admin.messaging() : null;
  }

  /**
   * Enregistrer un token FCM pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} fcmToken - Token FCM du dispositif
   * @param {string} deviceType - Type de dispositif (android, ios, web)
   */
  async registerFCMToken(userId, fcmToken, deviceType = 'web') {
    try {
      const query = `
        INSERT INTO user_fcm_tokens (user_id, fcm_token, device_type, created_at, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, fcm_token) 
        DO UPDATE SET 
          device_type = EXCLUDED.device_type,
          updated_at = CURRENT_TIMESTAMP,
          is_active = true
      `;
      
      await db.query(query, [userId, fcmToken, deviceType]);
      
      console.log('Token FCM enregistré:', {
        userId,
        deviceType,
        tokenPreview: fcmToken.substring(0, 20) + '...'
      });
      
      return { success: true };
    } catch (error) {
      console.error('Erreur lors de l\'enregistrement du token FCM:', error);
      throw error;
    }
  }

  /**
   * Supprimer un token FCM
   * @param {number} userId - ID de l'utilisateur
   * @param {string} fcmToken - Token FCM à supprimer
   */
  async unregisterFCMToken(userId, fcmToken) {
    try {
      const query = `
        UPDATE user_fcm_tokens 
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND fcm_token = $2
      `;
      
      await db.query(query, [userId, fcmToken]);
      
      console.log('Token FCM désactivé:', {
        userId,
        tokenPreview: fcmToken.substring(0, 20) + '...'
      });
      
      return { success: true };
    } catch (error) {
      console.error('Erreur lors de la suppression du token FCM:', error);
      throw error;
    }
  }

  /**
   * Obtenir les tokens FCM actifs d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   */
  async getUserFCMTokens(userId) {
    try {
      const query = `
        SELECT fcm_token, device_type
        FROM user_fcm_tokens
        WHERE user_id = $1 AND is_active = true
        ORDER BY updated_at DESC
      `;
      
      const result = await db.query(query, [userId]);
      return result.rows;
    } catch (error) {
      console.error('Erreur lors de la récupération des tokens FCM:', error);
      return [];
    }
  }

  /**
   * Envoyer une notification push à un utilisateur
   * @param {number} userId - ID de l'utilisateur destinataire
   * @param {Object} notification - Contenu de la notification
   */
  async sendPushNotification(userId, notification) {
    if (!this.messaging) {
      console.log('Firebase non configuré - notification push ignorée');
      return { success: false, reason: 'firebase_not_configured' };
    }

    try {
      const tokens = await this.getUserFCMTokens(userId);
      
      if (tokens.length === 0) {
        console.log('Aucun token FCM trouvé pour l\'utilisateur:', userId);
        return { success: false, reason: 'no_tokens' };
      }

      const message = {
        notification: {
          title: notification.title,
          body: notification.body,
          icon: notification.icon || '/icon-192x192.png'
        },
        data: {
          type: notification.type || 'general',
          ...notification.data
        },
        tokens: tokens.map(t => t.fcm_token)
      };

      const response = await this.messaging.sendMulticast(message);
      
      // Traiter les tokens invalides
      if (response.failureCount > 0) {
        await this.handleFailedTokens(userId, tokens, response.responses);
      }

      console.log('Notification push envoyée:', {
        userId,
        successCount: response.successCount,
        failureCount: response.failureCount,
        title: notification.title
      });

      return {
        success: true,
        successCount: response.successCount,
        failureCount: response.failureCount
      };
    } catch (error) {
      console.error('Erreur lors de l\'envoi de la notification push:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Gérer les tokens FCM invalides
   * @param {number} userId - ID de l'utilisateur
   * @param {Array} tokens - Liste des tokens
   * @param {Array} responses - Réponses de Firebase
   */
  async handleFailedTokens(userId, tokens, responses) {
    try {
      const invalidTokens = [];
      
      responses.forEach((response, index) => {
        if (!response.success) {
          const errorCode = response.error?.code;
          if (errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered') {
            invalidTokens.push(tokens[index].fcm_token);
          }
        }
      });

      if (invalidTokens.length > 0) {
        const query = `
          UPDATE user_fcm_tokens 
          SET is_active = false, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND fcm_token = ANY($2)
        `;
        
        await db.query(query, [userId, invalidTokens]);
        
        console.log('Tokens FCM invalides supprimés:', {
          userId,
          count: invalidTokens.length
        });
      }
    } catch (error) {
      console.error('Erreur lors du nettoyage des tokens invalides:', error);
    }
  }

  /**
   * Envoyer une notification de nouveau colis
   * @param {number} travelerId - ID du voyageur
   * @param {Object} packageData - Données du colis
   */
  async notifyNewPackageRequest(travelerId, packageData) {
    const notification = {
      title: '📦 Nouvelle demande de colis',
      body: `Nouveau colis de ${packageData.origin} vers ${packageData.destination}`,
      type: 'package_request',
      icon: '/icons/package.png',
      data: {
        packageId: packageData.id.toString(),
        tripId: packageData.trip_id?.toString(),
        action: 'view_package'
      }
    };

    await this.sendPushNotification(travelerId, notification);
    
    // Envoyer aussi via Socket.IO
    socketService.notifyNewPackageRequest(travelerId, packageData);
  }

  /**
   * Envoyer une notification de changement de statut
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} packageData - Données du colis
   * @param {string} newStatus - Nouveau statut
   */
  async notifyPackageStatusUpdate(userId, packageData, newStatus) {
    const statusMessages = {
      'requested': '📋 Votre colis a été demandé',
      'accepted': '✅ Votre colis a été accepté',
      'picked_up': '📦 Votre colis a été pris en charge',
      'in_transit': '🚗 Votre colis est en transit',
      'arrived': '📍 Votre colis est arrivé à destination',
      'delivered_confirmed': '🎉 Votre colis a été livré et confirmé',
      'dispute': '⚠️ Un litige a été ouvert pour votre colis'
    };

    const notification = {
      title: 'Mise à jour de votre colis',
      body: statusMessages[newStatus] || `Statut mis à jour: ${newStatus}`,
      type: 'status_update',
      icon: '/icons/status.png',
      data: {
        packageId: packageData.id.toString(),
        status: newStatus,
        action: 'view_tracking'
      }
    };

    await this.sendPushNotification(userId, notification);
  }

  /**
   * Envoyer une notification de géolocalisation
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} locationData - Données de localisation
   */
  async notifyLocationUpdate(userId, locationData) {
    const notification = {
      title: '📍 Mise à jour de position',
      body: 'Le voyageur a mis à jour sa position',
      type: 'location_update',
      icon: '/icons/location.png',
      data: {
        tripId: locationData.tripId?.toString(),
        latitude: locationData.latitude?.toString(),
        longitude: locationData.longitude?.toString(),
        action: 'view_map'
      }
    };

    await this.sendPushNotification(userId, notification);
  }

  /**
   * Envoyer une notification de livraison imminente
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} packageData - Données du colis
   * @param {number} estimatedMinutes - Minutes estimées avant livraison
   */
  async notifyDeliveryImminent(userId, packageData, estimatedMinutes) {
    const notification = {
      title: '🚚 Livraison imminente',
      body: `Votre colis arrivera dans environ ${estimatedMinutes} minutes`,
      type: 'delivery_imminent',
      icon: '/icons/delivery.png',
      data: {
        packageId: packageData.id.toString(),
        estimatedMinutes: estimatedMinutes.toString(),
        action: 'prepare_delivery'
      }
    };

    await this.sendPushNotification(userId, notification);
  }

  /**
   * Envoyer une notification de livraison imminente
   * @param {number} userId - ID de l'utilisateur à notifier
   * @param {string} packageTitle - Titre du colis
   * @param {string} estimatedTime - Temps estimé de livraison
   * @param {number} packageId - ID du colis
   */
  async sendDeliveryImminentNotification(userId, packageTitle, estimatedTime, packageId) {
    try {
      const notification = {
        title: '📦 Livraison imminente',
        body: `Votre colis "${packageTitle}" sera livré dans ${estimatedTime}`,
        data: {
          type: 'delivery_imminent',
          packageId: packageId.toString(),
          action: 'view_package'
        }
      };

      await this.sendNotificationToUser(userId, notification);
      
      // Notifier aussi via Socket.IO
      socketService.notifyDeliveryImminent(userId, {
        packageId,
        packageTitle,
        estimatedTime
      });
    } catch (error) {
      console.error('Erreur lors de l\'envoi de la notification de livraison imminente:', error);
    }
  }

  /**
   * Envoyer une notification de mise à jour de suivi
   * @param {number} userId - ID de l'utilisateur à notifier
   * @param {string} packageTitle - Titre du colis
   * @param {string} description - Description de l'étape
   * @param {number} packageId - ID du colis
   */
  async sendTrackingUpdateNotification(userId, packageTitle, description, packageId) {
    try {
      const notification = {
        title: '📍 Mise à jour de suivi',
        body: `${packageTitle}: ${description}`,
        data: {
          type: 'tracking_update',
          packageId: packageId.toString(),
          action: 'view_timeline'
        }
      };

      await this.sendNotificationToUser(userId, notification);
    } catch (error) {
      console.error('Erreur lors de l\'envoi de la notification de suivi:', error);
    }
  }

  /**
   * Envoyer une notification de nouvelle photo ajoutée
   * @param {number} userId - ID de l'utilisateur à notifier
   * @param {string} packageTitle - Titre du colis
   * @param {string} stepDescription - Description de l'étape
   * @param {number} packageId - ID du colis
   */
  async sendPhotoAddedNotification(userId, packageTitle, stepDescription, packageId) {
    try {
      const notification = {
        title: '📷 Nouvelle photo ajoutée',
        body: `${packageTitle}: ${stepDescription}`,
        data: {
          type: 'photo_added',
          packageId: packageId.toString(),
          action: 'view_photos'
        }
      };

      await this.sendNotificationToUser(userId, notification);
    } catch (error) {
      console.error('Erreur lors de l\'envoi de la notification de photo:', error);
    }
  }

  /**
   * Envoyer une notification de nouvelle évaluation reçue
   * @param {number} userId - ID de l'utilisateur à notifier
   * @param {number} rating - Note reçue
   * @param {string} comment - Commentaire (optionnel)
   * @param {string} raterName - Nom de l'évaluateur
   */
  async sendNewRatingNotification(userId, rating, comment, raterName) {
    try {
      const stars = '⭐'.repeat(rating);
      const notification = {
        title: '⭐ Nouvelle évaluation',
        body: `${raterName} vous a donné ${stars} (${rating}/5)${comment ? ': ' + comment.substring(0, 50) : ''}`,
        data: {
          type: 'new_rating',
          rating: rating.toString(),
          action: 'view_ratings'
        }
      };

      await this.sendNotificationToUser(userId, notification);
    } catch (error) {
      console.error('Erreur lors de l\'envoi de la notification d\'évaluation:', error);
    }
  }

  /**
   * Nettoyer les anciens tokens FCM inactifs
   */
  async cleanupOldTokens() {
    try {
      const query = `
        DELETE FROM user_fcm_tokens
        WHERE is_active = false 
        AND updated_at < NOW() - INTERVAL '30 days'
      `;
      
      const result = await db.query(query);
      
      console.log('Nettoyage des anciens tokens FCM:', {
        deletedCount: result.rowCount
      });
    } catch (error) {
      console.error('Erreur lors du nettoyage des tokens FCM:', error);
    }
  }
}

module.exports = new NotificationService();