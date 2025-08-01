const db = require('../config/database');
const socketService = require('./socketService');
const notificationService = require('./notificationService');

/**
 * Service pour l'interface de suivi visuel des colis
 * Timeline avec étapes, statuts et photos
 */
class VisualTrackingService {
  /**
   * Créer une nouvelle étape de suivi pour un colis
   * @param {number} packageId - ID du colis
   * @param {string} status - Statut de l'étape
   * @param {string} description - Description de l'étape
   * @param {string} location - Localisation (optionnel)
   * @param {string} photoUrl - URL de la photo (optionnel)
   * @param {number} userId - ID de l'utilisateur qui crée l'étape
   * @returns {Object} Résultat de l'opération
   */
  async createTrackingStep(packageId, status, description, location = null, photoUrl = null, userId) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Vérifier que le colis existe et que l'utilisateur a les permissions
      const packageQuery = `
        SELECT p.*, u.first_name, u.last_name
        FROM packages p
        JOIN users u ON p.sender_id = u.id
        WHERE p.id = $1
      `;
      const packageResult = await client.query(packageQuery, [packageId]);
      
      if (packageResult.rows.length === 0) {
        throw new Error('Colis non trouvé');
      }

      const packageData = packageResult.rows[0];
      
      // Vérifier les permissions (expéditeur, voyageur ou admin)
      if (packageData.sender_id !== userId && 
          packageData.traveler_id !== userId && 
          userId !== 'admin') {
        throw new Error('Permission refusée');
      }

      // Créer l'étape de suivi
      const insertQuery = `
        INSERT INTO package_visual_tracking (
          package_id, status, description, location, photo_url, 
          created_by, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
      `;
      
      const result = await client.query(insertQuery, [
        packageId, status, description, location, photoUrl, userId
      ]);

      const trackingStep = result.rows[0];

      // Mettre à jour le statut du colis si nécessaire
      if (this.shouldUpdatePackageStatus(status)) {
        await client.query(
          'UPDATE packages SET status = $1, updated_at = NOW() WHERE id = $2',
          [status, packageId]
        );
      }

      await client.query('COMMIT');

      // Notifier les parties concernées
      await this.notifyTrackingUpdate(packageData, trackingStep);

      return {
        success: true,
        data: {
          id: trackingStep.id,
          packageId: trackingStep.package_id,
          status: trackingStep.status,
          description: trackingStep.description,
          location: trackingStep.location,
          photoUrl: trackingStep.photo_url,
          createdBy: trackingStep.created_by,
          createdAt: trackingStep.created_at
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Obtenir la timeline complète d'un colis
   * @param {number} packageId - ID du colis
   * @param {number} userId - ID de l'utilisateur qui fait la demande
   * @returns {Object} Timeline du colis
   */
  async getPackageTimeline(packageId, userId) {
    try {
      // Vérifier les permissions d'accès au colis
      const packageQuery = `
        SELECT p.*, 
               s.first_name as sender_first_name, s.last_name as sender_last_name,
               t.first_name as traveler_first_name, t.last_name as traveler_last_name
        FROM packages p
        JOIN users s ON p.sender_id = s.id
        LEFT JOIN users t ON p.traveler_id = t.id
        WHERE p.id = $1
      `;
      
      const packageResult = await db.query(packageQuery, [packageId]);
      
      if (packageResult.rows.length === 0) {
        throw new Error('Colis non trouvé');
      }

      const packageData = packageResult.rows[0];
      
      // Vérifier les permissions
      if (packageData.sender_id !== userId && 
          packageData.traveler_id !== userId) {
        throw new Error('Permission refusée');
      }

      // Récupérer toutes les étapes de suivi
      const timelineQuery = `
        SELECT pt.*, 
               u.first_name, u.last_name, u.profile_picture
        FROM package_visual_tracking pt
        JOIN users u ON pt.created_by = u.id
        WHERE pt.package_id = $1
        ORDER BY pt.created_at ASC
      `;
      
      const timelineResult = await db.query(timelineQuery, [packageId]);
      
      const timeline = timelineResult.rows.map(step => ({
        id: step.id,
        status: step.status,
        description: step.description,
        location: step.location,
        photoUrl: step.photo_url,
        createdAt: step.created_at,
        createdBy: {
          id: step.created_by,
          firstName: step.first_name,
          lastName: step.last_name,
          profilePicture: step.profile_picture
        }
      }));

      // Ajouter les étapes automatiques basées sur les données du colis
      const automaticSteps = this.generateAutomaticSteps(packageData);
      
      // Fusionner et trier toutes les étapes
      const allSteps = [...automaticSteps, ...timeline]
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      return {
        success: true,
        data: {
          package: {
            id: packageData.id,
            title: packageData.title,
            status: packageData.status,
            sender: {
              firstName: packageData.sender_first_name,
              lastName: packageData.sender_last_name
            },
            traveler: packageData.traveler_id ? {
              firstName: packageData.traveler_first_name,
              lastName: packageData.traveler_last_name
            } : null,
            pickupLocation: packageData.pickup_location,
            deliveryLocation: packageData.delivery_location,
            createdAt: packageData.created_at
          },
          timeline: allSteps,
          currentStatus: packageData.status,
          progress: this.calculateProgress(packageData.status)
        }
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Obtenir les étapes de suivi récentes pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {number} limit - Nombre d'étapes à récupérer
   * @returns {Object} Étapes récentes
   */
  async getRecentTrackingSteps(userId, limit = 10) {
    try {
      const query = `
        SELECT pt.*, p.title as package_title, p.status as package_status,
               u.first_name, u.last_name, u.profile_picture
        FROM package_visual_tracking pt
        JOIN packages p ON pt.package_id = p.id
        JOIN users u ON pt.created_by = u.id
        WHERE p.sender_id = $1 OR p.traveler_id = $1
        ORDER BY pt.created_at DESC
        LIMIT $2
      `;
      
      const result = await db.query(query, [userId, limit]);
      
      const steps = result.rows.map(step => ({
        id: step.id,
        packageId: step.package_id,
        packageTitle: step.package_title,
        packageStatus: step.package_status,
        status: step.status,
        description: step.description,
        location: step.location,
        photoUrl: step.photo_url,
        createdAt: step.created_at,
        createdBy: {
          id: step.created_by,
          firstName: step.first_name,
          lastName: step.last_name,
          profilePicture: step.profile_picture
        }
      }));

      return {
        success: true,
        data: steps
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Mettre à jour une étape de suivi existante
   * @param {number} stepId - ID de l'étape
   * @param {Object} updates - Mises à jour
   * @param {number} userId - ID de l'utilisateur
   * @returns {Object} Résultat de l'opération
   */
  async updateTrackingStep(stepId, updates, userId) {
    try {
      // Vérifier que l'étape existe et que l'utilisateur peut la modifier
      const stepQuery = `
        SELECT pt.*, p.sender_id, p.traveler_id
        FROM package_visual_tracking pt
        JOIN packages p ON pt.package_id = p.id
        WHERE pt.id = $1
      `;
      
      const stepResult = await db.query(stepQuery, [stepId]);
      
      if (stepResult.rows.length === 0) {
        throw new Error('Étape de suivi non trouvée');
      }

      const step = stepResult.rows[0];
      
      // Vérifier les permissions
      if (step.created_by !== userId && 
          step.sender_id !== userId && 
          step.traveler_id !== userId) {
        throw new Error('Permission refusée');
      }

      // Construire la requête de mise à jour
      const allowedFields = ['description', 'location', 'photo_url'];
      const updateFields = [];
      const values = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key) && value !== undefined) {
          updateFields.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      }

      if (updateFields.length === 0) {
        throw new Error('Aucune mise à jour valide fournie');
      }

      values.push(stepId);
      
      const updateQuery = `
        UPDATE package_visual_tracking 
        SET ${updateFields.join(', ')}, updated_at = NOW()
        WHERE id = $${paramIndex}
        RETURNING *
      `;
      
      const result = await db.query(updateQuery, values);
      
      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Supprimer une étape de suivi
   * @param {number} stepId - ID de l'étape
   * @param {number} userId - ID de l'utilisateur
   * @returns {Object} Résultat de l'opération
   */
  async deleteTrackingStep(stepId, userId) {
    try {
      // Vérifier que l'étape existe et que l'utilisateur peut la supprimer
      const stepQuery = `
        SELECT pt.*, p.sender_id, p.traveler_id
        FROM package_visual_tracking pt
        JOIN packages p ON pt.package_id = p.id
        WHERE pt.id = $1
      `;
      
      const stepResult = await db.query(stepQuery, [stepId]);
      
      if (stepResult.rows.length === 0) {
        throw new Error('Étape de suivi non trouvée');
      }

      const step = stepResult.rows[0];
      
      // Vérifier les permissions (seul le créateur peut supprimer)
      if (step.created_by !== userId) {
        throw new Error('Seul le créateur peut supprimer cette étape');
      }

      await db.query('DELETE FROM package_visual_tracking WHERE id = $1', [stepId]);
      
      return {
        success: true,
        message: 'Étape de suivi supprimée avec succès'
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Générer des étapes automatiques basées sur les données du colis
   * @param {Object} packageData - Données du colis
   * @returns {Array} Étapes automatiques
   */
  generateAutomaticSteps(packageData) {
    const steps = [];
    
    // Étape de création
    steps.push({
      id: `auto_created_${packageData.id}`,
      status: 'created',
      description: 'Colis créé et publié',
      location: packageData.pickup_location,
      photoUrl: null,
      createdAt: packageData.created_at,
      createdBy: {
        id: packageData.sender_id,
        firstName: packageData.sender_first_name,
        lastName: packageData.sender_last_name
      },
      isAutomatic: true
    });

    // Étape d'acceptation si un voyageur est assigné
    if (packageData.traveler_id && packageData.accepted_at) {
      steps.push({
        id: `auto_accepted_${packageData.id}`,
        status: 'accepted',
        description: 'Colis accepté par un voyageur',
        location: null,
        photoUrl: null,
        createdAt: packageData.accepted_at,
        createdBy: {
          id: packageData.traveler_id,
          firstName: packageData.traveler_first_name,
          lastName: packageData.traveler_last_name
        },
        isAutomatic: true
      });
    }

    // Étape de livraison si le colis est livré
    if (packageData.status === 'delivered' && packageData.delivered_at) {
      steps.push({
        id: `auto_delivered_${packageData.id}`,
        status: 'delivered',
        description: 'Colis livré avec succès',
        location: packageData.delivery_location,
        photoUrl: null,
        createdAt: packageData.delivered_at,
        createdBy: {
          id: packageData.traveler_id,
          firstName: packageData.traveler_first_name,
          lastName: packageData.traveler_last_name
        },
        isAutomatic: true
      });
    }

    return steps;
  }

  /**
   * Calculer le pourcentage de progression basé sur le statut
   * @param {string} status - Statut du colis
   * @returns {number} Pourcentage de progression
   */
  calculateProgress(status) {
    const progressMap = {
      'pending': 10,
      'accepted': 25,
      'picked_up': 50,
      'in_transit': 75,
      'delivered': 100,
      'confirmed': 100,
      'cancelled': 0,
      'disputed': 50
    };
    
    return progressMap[status] || 0;
  }

  /**
   * Déterminer si le statut doit mettre à jour le statut du colis
   * @param {string} status - Statut de l'étape
   * @returns {boolean} True si le statut du colis doit être mis à jour
   */
  shouldUpdatePackageStatus(status) {
    const statusesToUpdate = [
      'picked_up', 'in_transit', 'delivered', 'confirmed', 'cancelled'
    ];
    
    return statusesToUpdate.includes(status);
  }

  /**
   * Notifier les parties concernées d'une mise à jour de suivi
   * @param {Object} packageData - Données du colis
   * @param {Object} trackingStep - Étape de suivi
   */
  async notifyTrackingUpdate(packageData, trackingStep) {
    try {
      // Notifier via Socket.IO
      socketService.notifyTrackingUpdate(packageData.id, {
        step: trackingStep,
        package: {
          id: packageData.id,
          title: packageData.title,
          status: packageData.status
        }
      });

      // Notifier via push notification
      const recipients = [packageData.sender_id];
      if (packageData.traveler_id) {
        recipients.push(packageData.traveler_id);
      }

      for (const userId of recipients) {
        if (userId !== trackingStep.created_by) {
          await notificationService.sendTrackingUpdateNotification(
            userId,
            packageData.title,
            trackingStep.description,
            packageData.id
          );
        }
      }
    } catch (error) {
      console.error('Erreur lors de l\'envoi des notifications de suivi:', error);
    }
  }

  /**
   * Obtenir les statistiques de suivi pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} period - Période (7d, 30d, 90d, 1y, all)
   * @returns {Object} Statistiques de suivi
   */
  async getTrackingStats(userId, period = '30d') {
    try {
      const dateFilter = this.getDateFilter(period);
      
      const query = `
        SELECT 
          COUNT(DISTINCT pt.package_id) as packages_tracked,
          COUNT(pt.id) as total_steps,
          COUNT(CASE WHEN pt.photo_url IS NOT NULL THEN 1 END) as steps_with_photos,
          AVG(CASE WHEN p.status = 'delivered' THEN 
            EXTRACT(EPOCH FROM (p.delivered_at - p.created_at))/3600 
          END) as avg_delivery_time_hours
        FROM package_visual_tracking pt
        JOIN packages p ON pt.package_id = p.id
        WHERE (p.sender_id = $1 OR p.traveler_id = $1)
        ${dateFilter ? `AND ${dateFilter.replace('created_at', 'pt.created_at')}` : ''}
      `;
      
      const result = await db.query(query, [userId]);
      const stats = result.rows[0];
      
      return {
        success: true,
        data: {
          packagesTracked: parseInt(stats.packages_tracked) || 0,
          totalSteps: parseInt(stats.total_steps) || 0,
          stepsWithPhotos: parseInt(stats.steps_with_photos) || 0,
          photoRate: stats.total_steps > 0 ? 
            (stats.steps_with_photos / stats.total_steps * 100).toFixed(2) : 0,
          avgDeliveryTimeHours: parseFloat(stats.avg_delivery_time_hours) || 0,
          period
        }
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Obtenir le filtre de date pour une période donnée
   * @param {string} period - Période
   * @returns {string} Filtre SQL
   */
  getDateFilter(period) {
    const filters = {
      '7d': "created_at >= NOW() - INTERVAL '7 days'",
      '30d': "created_at >= NOW() - INTERVAL '30 days'",
      '90d': "created_at >= NOW() - INTERVAL '90 days'",
      '1y': "created_at >= NOW() - INTERVAL '1 year'",
      'all': null
    };
    
    return filters[period] || filters['30d'];
  }

  /**
   * Obtenir les étapes de suivi avec photos pour un colis
   * @param {number} packageId - ID du colis
   * @param {number} userId - ID de l'utilisateur
   * @returns {Object} Étapes avec photos
   */
  async getPackagePhotos(packageId, userId) {
    try {
      // Vérifier les permissions d'accès au colis
      const packageQuery = `
        SELECT sender_id, traveler_id
        FROM packages
        WHERE id = $1
      `;
      
      const packageResult = await db.query(packageQuery, [packageId]);
      
      if (packageResult.rows.length === 0) {
        throw new Error('Colis non trouvé');
      }

      const packageData = packageResult.rows[0];
      
      // Vérifier les permissions
      if (packageData.sender_id !== userId && 
          packageData.traveler_id !== userId) {
        throw new Error('Permission refusée');
      }

      // Récupérer les étapes avec photos
      const photosQuery = `
        SELECT pt.*, 
               u.first_name, u.last_name, u.profile_picture
        FROM package_visual_tracking pt
        JOIN users u ON pt.created_by = u.id
        WHERE pt.package_id = $1 AND pt.photo_url IS NOT NULL
        ORDER BY pt.created_at DESC
      `;
      
      const result = await db.query(photosQuery, [packageId]);
      
      const photos = result.rows.map(step => ({
        id: step.id,
        status: step.status,
        description: step.description,
        location: step.location,
        photoUrl: step.photo_url,
        createdAt: step.created_at,
        createdBy: {
          id: step.created_by,
          firstName: step.first_name,
          lastName: step.last_name,
          profilePicture: step.profile_picture
        }
      }));

      return {
        success: true,
        data: photos
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Obtenir les étapes de suivi par statut
   * @param {number} packageId - ID du colis
   * @param {string} status - Statut à filtrer
   * @param {number} userId - ID de l'utilisateur
   * @returns {Object} Étapes filtrées par statut
   */
  async getTrackingStepsByStatus(packageId, status, userId) {
    try {
      // Vérifier les permissions d'accès au colis
      const packageQuery = `
        SELECT sender_id, traveler_id
        FROM packages
        WHERE id = $1
      `;
      
      const packageResult = await db.query(packageQuery, [packageId]);
      
      if (packageResult.rows.length === 0) {
        throw new Error('Colis non trouvé');
      }

      const packageData = packageResult.rows[0];
      
      // Vérifier les permissions
      if (packageData.sender_id !== userId && 
          packageData.traveler_id !== userId) {
        throw new Error('Permission refusée');
      }

      // Récupérer les étapes par statut
      const stepsQuery = `
        SELECT pt.*, 
               u.first_name, u.last_name, u.profile_picture
        FROM package_visual_tracking pt
        JOIN users u ON pt.created_by = u.id
        WHERE pt.package_id = $1 AND pt.status = $2
        ORDER BY pt.created_at DESC
      `;
      
      const result = await db.query(stepsQuery, [packageId, status]);
      
      const steps = result.rows.map(step => ({
        id: step.id,
        status: step.status,
        description: step.description,
        location: step.location,
        photoUrl: step.photo_url,
        createdAt: step.created_at,
        createdBy: {
          id: step.created_by,
          firstName: step.first_name,
          lastName: step.last_name,
          profilePicture: step.profile_picture
        }
      }));

      return {
        success: true,
        data: steps
      };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = new VisualTrackingService();