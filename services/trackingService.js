const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const socketService = require('./socketService');

/**
 * Service de suivi des colis ChapChap
 * Gère les statuts, transitions et notifications
 */

// Statuts possibles des colis
const PACKAGE_STATUS = {
  REQUESTED: 'requested',        // 📥 Demandé
  ACCEPTED: 'accepted',          // ✅ Accepté par un voyageur
  PICKED_UP: 'picked_up',        // 📦 Pris en charge
  IN_TRANSIT: 'in_transit',      // 🚚 En transit
  ARRIVED: 'arrived',            // 📍 Arrivé à destination
  DELIVERED: 'delivered',        // ✔️ Livré & confirmé
  DISPUTED: 'disputed'           // ⚠️ Litige
};

// Transitions autorisées entre statuts
const ALLOWED_TRANSITIONS = {
  [PACKAGE_STATUS.REQUESTED]: [PACKAGE_STATUS.ACCEPTED, PACKAGE_STATUS.DISPUTED],
  [PACKAGE_STATUS.ACCEPTED]: [PACKAGE_STATUS.PICKED_UP, PACKAGE_STATUS.DISPUTED],
  [PACKAGE_STATUS.PICKED_UP]: [PACKAGE_STATUS.IN_TRANSIT, PACKAGE_STATUS.DISPUTED],
  [PACKAGE_STATUS.IN_TRANSIT]: [PACKAGE_STATUS.ARRIVED, PACKAGE_STATUS.DISPUTED],
  [PACKAGE_STATUS.ARRIVED]: [PACKAGE_STATUS.DELIVERED, PACKAGE_STATUS.DISPUTED],
  [PACKAGE_STATUS.DELIVERED]: [PACKAGE_STATUS.DISPUTED],
  [PACKAGE_STATUS.DISPUTED]: [] // Statut final, nécessite intervention manuelle
};

// Messages de statut pour les notifications
const STATUS_MESSAGES = {
  [PACKAGE_STATUS.REQUESTED]: {
    icon: '📥',
    title: 'Colis demandé',
    description: 'Votre demande de transport a été créée'
  },
  [PACKAGE_STATUS.ACCEPTED]: {
    icon: '✅',
    title: 'Colis accepté',
    description: 'Un voyageur a accepté de transporter votre colis'
  },
  [PACKAGE_STATUS.PICKED_UP]: {
    icon: '📦',
    title: 'Colis pris en charge',
    description: 'Le voyageur a récupéré votre colis'
  },
  [PACKAGE_STATUS.IN_TRANSIT]: {
    icon: '🚚',
    title: 'Colis en transit',
    description: 'Votre colis est en cours de transport'
  },
  [PACKAGE_STATUS.ARRIVED]: {
    icon: '📍',
    title: 'Colis arrivé',
    description: 'Votre colis est arrivé à destination'
  },
  [PACKAGE_STATUS.DELIVERED]: {
    icon: '✔️',
    title: 'Colis livré',
    description: 'Votre colis a été livré avec succès'
  },
  [PACKAGE_STATUS.DISPUTED]: {
    icon: '⚠️',
    title: 'Litige déclaré',
    description: 'Un problème a été signalé pour ce colis'
  }
};

class TrackingService {
  /**
   * Mettre à jour le statut d'un colis
   * @param {number} packageId - ID du colis
   * @param {string} newStatus - Nouveau statut
   * @param {number} userId - ID de l'utilisateur effectuant l'action
   * @param {Object} options - Options supplémentaires
   * @returns {Object} Résultat de la mise à jour
   */
  async updatePackageStatus(packageId, newStatus, userId, options = {}) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Récupérer les informations actuelles du colis
      const packageQuery = `
        SELECT p.*, t.traveler_id, t.departure_date, t.arrival_date,
               u_sender.first_name as sender_name, u_sender.email as sender_email,
               u_traveler.first_name as traveler_name, u_traveler.email as traveler_email
        FROM packages p
        JOIN trips t ON p.trip_id = t.id
        JOIN users u_sender ON p.sender_id = u_sender.id
        LEFT JOIN users u_traveler ON t.traveler_id = u_traveler.id
        WHERE p.id = $1
      `;
      const packageResult = await client.query(packageQuery, [packageId]);
      
      if (packageResult.rows.length === 0) {
        throw new Error('Colis non trouvé');
      }
      
      const packageData = packageResult.rows[0];
      const currentStatus = packageData.status;
      
      // Vérifier si la transition est autorisée
      if (!this.isTransitionAllowed(currentStatus, newStatus)) {
        throw new Error(`Transition non autorisée de ${currentStatus} vers ${newStatus}`);
      }
      
      // Vérifier les permissions
      if (!this.hasPermissionToUpdate(packageData, userId, newStatus)) {
        throw new Error('Permission insuffisante pour cette action');
      }
      
      // Mettre à jour le statut du colis
      const updateQuery = `
        UPDATE packages 
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `;
      const updateResult = await client.query(updateQuery, [newStatus, packageId]);
      
      // Créer un enregistrement de suivi
      const trackingData = {
        packageId,
        status: newStatus,
        userId,
        notes: options.notes || null,
        location: options.location || null,
        photoPath: options.photoPath || null,
        timestamp: new Date()
      };
      
      const trackingId = await this.createTrackingRecord(client, trackingData);
      
      await client.query('COMMIT');
      
      // Envoyer les notifications via Socket.IO
      await this.sendStatusNotifications(packageData, newStatus, trackingData);
      
      return {
        success: true,
        package: updateResult.rows[0],
        tracking: { id: trackingId, ...trackingData },
        message: STATUS_MESSAGES[newStatus]
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Vérifier si une transition de statut est autorisée
   * @param {string} currentStatus - Statut actuel
   * @param {string} newStatus - Nouveau statut
   * @returns {boolean} Transition autorisée
   */
  isTransitionAllowed(currentStatus, newStatus) {
    if (!currentStatus) return newStatus === PACKAGE_STATUS.REQUESTED;
    return ALLOWED_TRANSITIONS[currentStatus]?.includes(newStatus) || false;
  }
  
  /**
   * Vérifier les permissions pour mettre à jour un statut
   * @param {Object} packageData - Données du colis
   * @param {number} userId - ID de l'utilisateur
   * @param {string} newStatus - Nouveau statut
   * @returns {boolean} Permission accordée
   */
  hasPermissionToUpdate(packageData, userId, newStatus) {
    const isOwner = packageData.sender_id === userId;
    const isTraveler = packageData.traveler_id === userId;
    
    switch (newStatus) {
      case PACKAGE_STATUS.ACCEPTED:
      case PACKAGE_STATUS.PICKED_UP:
      case PACKAGE_STATUS.IN_TRANSIT:
      case PACKAGE_STATUS.ARRIVED:
        return isTraveler;
      
      case PACKAGE_STATUS.DELIVERED:
        return isOwner; // Seul l'expéditeur peut confirmer la livraison
      
      case PACKAGE_STATUS.DISPUTED:
        return isOwner || isTraveler; // Les deux parties peuvent déclarer un litige
      
      default:
        return false;
    }
  }
  
  /**
   * Créer un enregistrement de suivi
   * @param {Object} client - Client de base de données
   * @param {Object} trackingData - Données de suivi
   * @returns {number} ID de l'enregistrement créé
   */
  async createTrackingRecord(client, trackingData) {
    const insertQuery = `
      INSERT INTO package_tracking 
      (package_id, status, user_id, notes, location, photo_path, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;
    
    const result = await client.query(insertQuery, [
      trackingData.packageId,
      trackingData.status,
      trackingData.userId,
      trackingData.notes,
      trackingData.location,
      trackingData.photoPath,
      trackingData.timestamp
    ]);
    
    return result.rows[0].id;
  }
  
  /**
   * Envoyer les notifications de changement de statut
   * @param {Object} packageData - Données du colis
   * @param {string} newStatus - Nouveau statut
   * @param {Object} trackingData - Données de suivi
   */
  async sendStatusNotifications(packageData, newStatus, trackingData) {
    const statusInfo = STATUS_MESSAGES[newStatus];
    
    // Notification pour l'expéditeur
    if (packageData.sender_id !== trackingData.userId) {
      const senderNotification = {
        type: 'package_status_update',
        packageId: packageData.id,
        status: newStatus,
        title: statusInfo.title,
        message: statusInfo.description,
        icon: statusInfo.icon,
        timestamp: trackingData.timestamp,
        data: {
          packageTitle: packageData.title,
          trackingId: trackingData.id
        }
      };
      
      if (socketService) {
        socketService.sendSystemNotification(packageData.sender_id, senderNotification);
      }
    }
    
    // Notification pour le voyageur
    if (packageData.traveler_id && packageData.traveler_id !== trackingData.userId) {
      const travelerNotification = {
        type: 'package_status_update',
        packageId: packageData.id,
        status: newStatus,
        title: statusInfo.title,
        message: statusInfo.description,
        icon: statusInfo.icon,
        timestamp: trackingData.timestamp,
        data: {
          packageTitle: packageData.title,
          trackingId: trackingData.id
        }
      };
      
      if (socketService) {
        socketService.sendSystemNotification(packageData.traveler_id, travelerNotification);
      }
    }
  }
  
  /**
   * Obtenir l'historique de suivi d'un colis
   * @param {number} packageId - ID du colis
   * @param {number} userId - ID de l'utilisateur demandeur
   * @returns {Array} Historique de suivi
   */
  async getPackageTracking(packageId, userId) {
    // Vérifier l'accès au colis
    const accessQuery = `
      SELECT p.sender_id, t.traveler_id
      FROM packages p
      JOIN trips t ON p.trip_id = t.id
      WHERE p.id = $1
    `;
    const accessResult = await db.query(accessQuery, [packageId]);
    
    if (accessResult.rows.length === 0) {
      throw new Error('Colis non trouvé');
    }
    
    const { sender_id, traveler_id } = accessResult.rows[0];
    if (userId !== sender_id && userId !== traveler_id) {
      throw new Error('Accès non autorisé à ce colis');
    }
    
    // Récupérer l'historique de suivi
    const trackingQuery = `
      SELECT pt.*, u.first_name, u.last_name
      FROM package_tracking pt
      JOIN users u ON pt.user_id = u.id
      WHERE pt.package_id = $1
      ORDER BY pt.created_at ASC
    `;
    
    const result = await db.query(trackingQuery, [packageId]);
    
    return result.rows.map(record => ({
      id: record.id,
      status: record.status,
      statusInfo: STATUS_MESSAGES[record.status],
      user: {
        id: record.user_id,
        name: `${record.first_name} ${record.last_name}`
      },
      notes: record.notes,
      location: record.location,
      photoPath: record.photo_path,
      timestamp: record.created_at
    }));
  }
  
  /**
   * Déclarer un litige
   * @param {number} packageId - ID du colis
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} disputeData - Données du litige
   * @returns {Object} Résultat de la déclaration
   */
  async createDispute(packageId, userId, disputeData) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // Mettre à jour le statut du colis
      await this.updatePackageStatus(packageId, PACKAGE_STATUS.DISPUTED, userId, {
        notes: `Litige déclaré: ${disputeData.reason}`
      });
      
      // Créer l'enregistrement de litige
      const disputeQuery = `
        INSERT INTO package_disputes 
        (package_id, reporter_id, reason, description, evidence_photos, created_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        RETURNING id
      `;
      
      const disputeResult = await client.query(disputeQuery, [
        packageId,
        userId,
        disputeData.reason,
        disputeData.description,
        JSON.stringify(disputeData.evidencePhotos || [])
      ]);
      
      await client.query('COMMIT');
      
      // Envoyer des notifications via Socket.IO
      if (socketService) {
        socketService.notifyDisputeCreated({
          packageId,
          disputeId: disputeResult.rows[0].id,
          reporterId: userId,
          reason: disputeData.reason
        });
      }
      
      return {
        success: true,
        disputeId: disputeResult.rows[0].id,
        message: 'Litige déclaré avec succès. Notre équipe va examiner votre demande.'
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Obtenir les statistiques de suivi
   * @param {number} userId - ID de l'utilisateur
   * @returns {Object} Statistiques
   */
  async getTrackingStats(userId) {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_packages,
        COUNT(CASE WHEN p.status = 'delivered' THEN 1 END) as delivered_packages,
        COUNT(CASE WHEN p.status = 'disputed' THEN 1 END) as disputed_packages,
        COUNT(CASE WHEN p.status IN ('in_transit', 'arrived') THEN 1 END) as active_packages
      FROM packages p
      JOIN trips t ON p.trip_id = t.id
      WHERE p.sender_id = $1 OR t.traveler_id = $1
    `;
    
    const result = await db.query(statsQuery, [userId]);
    return result.rows[0];
  }
}

module.exports = {
  TrackingService: new TrackingService(),
  PACKAGE_STATUS,
  STATUS_MESSAGES,
  ALLOWED_TRANSITIONS
};