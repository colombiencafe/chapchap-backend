const db = require('../config/database');
const socketService = require('./socketService');
const notificationService = require('./notificationService');

class RatingService {
  /**
   * Créer une évaluation
   * @param {number} raterId - ID de l'utilisateur qui note
   * @param {number} ratedUserId - ID de l'utilisateur noté
   * @param {number} packageId - ID du colis concerné
   * @param {number} rating - Note (1-5)
   * @param {string} comment - Commentaire optionnel
   * @param {string} type - Type d'évaluation ('sender' ou 'traveler')
   */
  async createRating(raterId, ratedUserId, packageId, rating, comment = '', type) {
    try {
      // Vérifier que l'utilisateur peut noter ce colis
      const canRate = await this.canUserRate(raterId, ratedUserId, packageId, type);
      if (!canRate.allowed) {
        throw new Error(canRate.reason);
      }

      // Vérifier si une évaluation existe déjà
      const existingRating = await this.getRating(raterId, ratedUserId, packageId);
      if (existingRating) {
        throw new Error('Vous avez déjà évalué cet utilisateur pour ce colis');
      }

      const query = `
        INSERT INTO user_ratings (
          rater_id, rated_user_id, package_id, rating, comment, rating_type, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING *
      `;

      const result = await db.query(query, [
        raterId, ratedUserId, packageId, rating, comment, type
      ]);

      const newRating = result.rows[0];

      // Mettre à jour les statistiques de l'utilisateur noté
      await this.updateUserRatingStats(ratedUserId);

      // Envoyer une notification
      await this.notifyNewRating(ratedUserId, newRating);

      console.log('Nouvelle évaluation créée:', {
        ratingId: newRating.id,
        raterId,
        ratedUserId,
        rating,
        type
      });

      return {
        success: true,
        data: {
          rating: {
            id: newRating.id,
            rating: newRating.rating,
            comment: newRating.comment,
            type: newRating.rating_type,
            createdAt: newRating.created_at
          }
        }
      };
    } catch (error) {
      console.error('Erreur lors de la création de l\'évaluation:', error);
      throw error;
    }
  }

  /**
   * Vérifier si un utilisateur peut noter un autre utilisateur
   * @param {number} raterId - ID de l'utilisateur qui note
   * @param {number} ratedUserId - ID de l'utilisateur noté
   * @param {number} packageId - ID du colis
   * @param {string} type - Type d'évaluation
   */
  async canUserRate(raterId, ratedUserId, packageId, type) {
    try {
      // Vérifier que le colis existe et est livré
      const packageQuery = `
        SELECT p.*, pt.status
        FROM packages p
        LEFT JOIN package_tracking pt ON p.id = pt.package_id
        WHERE p.id = $1
        ORDER BY pt.created_at DESC
        LIMIT 1
      `;

      const packageResult = await db.query(packageQuery, [packageId]);
      
      if (packageResult.rows.length === 0) {
        return { allowed: false, reason: 'Colis non trouvé' };
      }

      const packageData = packageResult.rows[0];
      
      if (packageData.status !== 'delivered_confirmed') {
        return { allowed: false, reason: 'Le colis doit être livré et confirmé pour pouvoir être évalué' };
      }

      // Vérifier les permissions selon le type d'évaluation
      if (type === 'sender') {
        // L'expéditeur note le voyageur
        if (packageData.sender_id !== raterId) {
          return { allowed: false, reason: 'Seul l\'expéditeur peut noter le voyageur' };
        }
        if (packageData.traveler_id !== ratedUserId) {
          return { allowed: false, reason: 'Utilisateur noté invalide' };
        }
      } else if (type === 'traveler') {
        // Le voyageur note l'expéditeur
        if (packageData.traveler_id !== raterId) {
          return { allowed: false, reason: 'Seul le voyageur peut noter l\'expéditeur' };
        }
        if (packageData.sender_id !== ratedUserId) {
          return { allowed: false, reason: 'Utilisateur noté invalide' };
        }
      } else {
        return { allowed: false, reason: 'Type d\'évaluation invalide' };
      }

      return { allowed: true };
    } catch (error) {
      console.error('Erreur lors de la vérification des permissions:', error);
      return { allowed: false, reason: 'Erreur lors de la vérification' };
    }
  }

  /**
   * Obtenir une évaluation existante
   * @param {number} raterId - ID de l'utilisateur qui note
   * @param {number} ratedUserId - ID de l'utilisateur noté
   * @param {number} packageId - ID du colis
   */
  async getRating(raterId, ratedUserId, packageId) {
    try {
      const query = `
        SELECT * FROM user_ratings
        WHERE rater_id = $1 AND rated_user_id = $2 AND package_id = $3
      `;

      const result = await db.query(query, [raterId, ratedUserId, packageId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Erreur lors de la récupération de l\'évaluation:', error);
      return null;
    }
  }

  /**
   * Obtenir les évaluations d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} type - Type d'évaluations ('received', 'given', 'all')
   * @param {number} page - Page (défaut: 1)
   * @param {number} limit - Limite par page (défaut: 10)
   */
  async getUserRatings(userId, type = 'received', page = 1, limit = 10) {
    try {
      const offset = (page - 1) * limit;
      let whereClause = '';
      let countWhereClause = '';
      const params = [userId, limit, offset];

      if (type === 'received') {
        whereClause = 'WHERE r.rated_user_id = $1';
        countWhereClause = 'WHERE rated_user_id = $1';
      } else if (type === 'given') {
        whereClause = 'WHERE r.rater_id = $1';
        countWhereClause = 'WHERE rater_id = $1';
      } else {
        whereClause = 'WHERE (r.rated_user_id = $1 OR r.rater_id = $1)';
        countWhereClause = 'WHERE (rated_user_id = $1 OR rater_id = $1)';
      }

      const query = `
        SELECT 
          r.*,
          rater.first_name as rater_first_name,
          rater.last_name as rater_last_name,
          rater.profile_picture as rater_profile_picture,
          rated.first_name as rated_first_name,
          rated.last_name as rated_last_name,
          rated.profile_picture as rated_profile_picture,
          p.title as package_title,
          p.origin,
          p.destination
        FROM user_ratings r
        JOIN users rater ON r.rater_id = rater.id
        JOIN users rated ON r.rated_user_id = rated.id
        JOIN packages p ON r.package_id = p.id
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3
      `;

      const countQuery = `
        SELECT COUNT(*) as total
        FROM user_ratings
        ${countWhereClause}
      `;

      const [ratingsResult, countResult] = await Promise.all([
        db.query(query, params),
        db.query(countQuery, [userId])
      ]);

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / limit);

      return {
        success: true,
        data: {
          ratings: ratingsResult.rows.map(rating => ({
            id: rating.id,
            rating: rating.rating,
            comment: rating.comment,
            type: rating.rating_type,
            createdAt: rating.created_at,
            rater: {
              id: rating.rater_id,
              firstName: rating.rater_first_name,
              lastName: rating.rater_last_name,
              profilePicture: rating.rater_profile_picture
            },
            ratedUser: {
              id: rating.rated_user_id,
              firstName: rating.rated_first_name,
              lastName: rating.rated_last_name,
              profilePicture: rating.rated_profile_picture
            },
            package: {
              id: rating.package_id,
              title: rating.package_title,
              origin: rating.origin,
              destination: rating.destination
            }
          })),
          pagination: {
            currentPage: page,
            totalPages,
            totalItems: total,
            itemsPerPage: limit
          }
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des évaluations:', error);
      throw error;
    }
  }

  /**
   * Obtenir les statistiques d'évaluation d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   */
  async getUserRatingStats(userId) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_ratings,
          AVG(rating)::DECIMAL(3,2) as average_rating,
          COUNT(CASE WHEN rating = 5 THEN 1 END) as five_stars,
          COUNT(CASE WHEN rating = 4 THEN 1 END) as four_stars,
          COUNT(CASE WHEN rating = 3 THEN 1 END) as three_stars,
          COUNT(CASE WHEN rating = 2 THEN 1 END) as two_stars,
          COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star,
          COUNT(CASE WHEN rating_type = 'sender' THEN 1 END) as as_sender,
          COUNT(CASE WHEN rating_type = 'traveler' THEN 1 END) as as_traveler
        FROM user_ratings
        WHERE rated_user_id = $1
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      return {
        success: true,
        data: {
          totalRatings: parseInt(stats.total_ratings),
          averageRating: parseFloat(stats.average_rating) || 0,
          distribution: {
            fiveStars: parseInt(stats.five_stars),
            fourStars: parseInt(stats.four_stars),
            threeStars: parseInt(stats.three_stars),
            twoStars: parseInt(stats.two_stars),
            oneStar: parseInt(stats.one_star)
          },
          byType: {
            asSender: parseInt(stats.as_sender),
            asTraveler: parseInt(stats.as_traveler)
          }
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques:', error);
      throw error;
    }
  }

  /**
   * Mettre à jour les statistiques d'évaluation dans le profil utilisateur
   * @param {number} userId - ID de l'utilisateur
   */
  async updateUserRatingStats(userId) {
    try {
      const stats = await this.getUserRatingStats(userId);
      
      const updateQuery = `
        UPDATE users 
        SET 
          rating_average = $2,
          rating_count = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `;

      await db.query(updateQuery, [
        userId,
        stats.data.averageRating,
        stats.data.totalRatings
      ]);

      console.log('Statistiques d\'évaluation mises à jour:', {
        userId,
        averageRating: stats.data.averageRating,
        totalRatings: stats.data.totalRatings
      });
    } catch (error) {
      console.error('Erreur lors de la mise à jour des statistiques:', error);
    }
  }

  /**
   * Obtenir les colis éligibles pour évaluation
   * @param {number} userId - ID de l'utilisateur
   */
  async getEligiblePackagesForRating(userId) {
    try {
      const query = `
        SELECT DISTINCT
          p.*,
          pt.status,
          CASE 
            WHEN p.sender_id = $1 THEN 'sender'
            WHEN p.traveler_id = $1 THEN 'traveler'
          END as user_role,
          CASE 
            WHEN p.sender_id = $1 THEN p.traveler_id
            WHEN p.traveler_id = $1 THEN p.sender_id
          END as other_user_id,
          CASE 
            WHEN p.sender_id = $1 THEN CONCAT(traveler.first_name, ' ', traveler.last_name)
            WHEN p.traveler_id = $1 THEN CONCAT(sender.first_name, ' ', sender.last_name)
          END as other_user_name,
          CASE 
            WHEN p.sender_id = $1 THEN traveler.profile_picture
            WHEN p.traveler_id = $1 THEN sender.profile_picture
          END as other_user_picture
        FROM packages p
        JOIN users sender ON p.sender_id = sender.id
        JOIN users traveler ON p.traveler_id = traveler.id
        LEFT JOIN package_tracking pt ON p.id = pt.package_id
        LEFT JOIN user_ratings ur ON (
          p.id = ur.package_id AND 
          ur.rater_id = $1
        )
        WHERE 
          (p.sender_id = $1 OR p.traveler_id = $1)
          AND pt.status = 'delivered_confirmed'
          AND ur.id IS NULL
        ORDER BY pt.created_at DESC
      `;

      const result = await db.query(query, [userId]);

      return {
        success: true,
        data: {
          packages: result.rows.map(pkg => ({
            id: pkg.id,
            title: pkg.title,
            origin: pkg.origin,
            destination: pkg.destination,
            userRole: pkg.user_role,
            otherUser: {
              id: pkg.other_user_id,
              name: pkg.other_user_name,
              profilePicture: pkg.other_user_picture
            }
          }))
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des colis éligibles:', error);
      throw error;
    }
  }

  /**
   * Envoyer une notification pour une nouvelle évaluation
   * @param {number} userId - ID de l'utilisateur qui reçoit l'évaluation
   * @param {Object} rating - Données de l'évaluation
   */
  async notifyNewRating(userId, rating) {
    try {
      // Récupérer les informations de l'évaluateur
      const raterQuery = `
        SELECT first_name, last_name FROM users WHERE id = $1
      `;
      const raterResult = await db.query(raterQuery, [rating.rater_id]);
      const rater = raterResult.rows[0];

      if (!rater) return;

      const raterName = `${rater.first_name} ${rater.last_name}`;
      const stars = '⭐'.repeat(rating.rating);

      // Notification push
      const notification = {
        title: '⭐ Nouvelle évaluation reçue',
        body: `${raterName} vous a donné ${stars} (${rating.rating}/5)`,
        type: 'new_rating',
        icon: '/icons/star.png',
        data: {
          ratingId: rating.id.toString(),
          raterId: rating.rater_id.toString(),
          rating: rating.rating.toString(),
          action: 'view_rating'
        }
      };

      await notificationService.sendPushNotification(userId, notification);

      // Notification Socket.IO
      socketService.emit(`user_${userId}`, 'new_rating', {
        rating: {
          id: rating.id,
          rating: rating.rating,
          comment: rating.comment,
          raterName,
          createdAt: rating.created_at
        },
        message: `Nouvelle évaluation de ${raterName}`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erreur lors de la notification d\'évaluation:', error);
    }
  }

  /**
   * Supprimer une évaluation (admin uniquement)
   * @param {number} ratingId - ID de l'évaluation
   * @param {number} adminId - ID de l'administrateur
   */
  async deleteRating(ratingId, adminId) {
    try {
      // Vérifier que l'utilisateur est admin
      const adminQuery = `
        SELECT role FROM users WHERE id = $1
      `;
      const adminResult = await db.query(adminQuery, [adminId]);
      
      if (!adminResult.rows[0] || adminResult.rows[0].role !== 'admin') {
        throw new Error('Permissions insuffisantes');
      }

      // Récupérer l'évaluation avant suppression
      const ratingQuery = `
        SELECT * FROM user_ratings WHERE id = $1
      `;
      const ratingResult = await db.query(ratingQuery, [ratingId]);
      
      if (ratingResult.rows.length === 0) {
        throw new Error('Évaluation non trouvée');
      }

      const rating = ratingResult.rows[0];

      // Supprimer l'évaluation
      const deleteQuery = `
        DELETE FROM user_ratings WHERE id = $1
      `;
      await db.query(deleteQuery, [ratingId]);

      // Mettre à jour les statistiques de l'utilisateur
      await this.updateUserRatingStats(rating.rated_user_id);

      console.log('Évaluation supprimée par admin:', {
        ratingId,
        adminId,
        ratedUserId: rating.rated_user_id
      });

      return { success: true };
    } catch (error) {
      console.error('Erreur lors de la suppression de l\'évaluation:', error);
      throw error;
    }
  }
}

module.exports = new RatingService();