const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const ratingService = require('../services/ratingService');

/**
 * @route POST /api/ratings
 * @desc Créer une nouvelle évaluation
 * @access Private
 */
router.post('/', [
  auth,
  body('ratedUserId').isInt().withMessage('ID utilisateur noté requis'),
  body('packageId').isInt().withMessage('ID colis requis'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Note doit être entre 1 et 5'),
  body('comment').optional().isLength({ max: 500 }).withMessage('Commentaire trop long (max 500 caractères)'),
  body('type').isIn(['sender', 'traveler']).withMessage('Type d\'évaluation invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    const { ratedUserId, packageId, rating, comment, type } = req.body;
    const raterId = req.user.id;

    const result = await ratingService.createRating(
      raterId, ratedUserId, packageId, rating, comment, type
    );

    res.status(201).json({
      success: true,
      message: 'Évaluation créée avec succès',
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la création de l\'évaluation:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la création de l\'évaluation'
    });
  }
});

/**
 * @route GET /api/ratings/user/:userId
 * @desc Obtenir les évaluations d'un utilisateur
 * @access Public
 */
router.get('/user/:userId', [
  param('userId').isInt().withMessage('ID utilisateur invalide'),
  query('type').optional().isIn(['received', 'given', 'all']).withMessage('Type invalide'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page invalide'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limite invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const userId = parseInt(req.params.userId);
    const type = req.query.type || 'received';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const result = await ratingService.getUserRatings(userId, type, page, limit);

    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des évaluations:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des évaluations'
    });
  }
});

/**
 * @route GET /api/ratings/user/:userId/stats
 * @desc Obtenir les statistiques d'évaluation d'un utilisateur
 * @access Public
 */
router.get('/user/:userId/stats', [
  param('userId').isInt().withMessage('ID utilisateur invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const userId = parseInt(req.params.userId);
    const result = await ratingService.getUserRatingStats(userId);

    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des statistiques'
    });
  }
});

/**
 * @route GET /api/ratings/eligible-packages
 * @desc Obtenir les colis éligibles pour évaluation
 * @access Private
 */
router.get('/eligible-packages', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await ratingService.getEligiblePackagesForRating(userId);

    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des colis éligibles:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des colis éligibles'
    });
  }
});

/**
 * @route GET /api/ratings/package/:packageId/can-rate
 * @desc Vérifier si l'utilisateur peut noter un colis
 * @access Private
 */
router.get('/package/:packageId/can-rate', [
  auth,
  param('packageId').isInt().withMessage('ID colis invalide'),
  query('ratedUserId').isInt().withMessage('ID utilisateur noté requis'),
  query('type').isIn(['sender', 'traveler']).withMessage('Type d\'évaluation invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const packageId = parseInt(req.params.packageId);
    const ratedUserId = parseInt(req.query.ratedUserId);
    const type = req.query.type;
    const raterId = req.user.id;

    const result = await ratingService.canUserRate(raterId, ratedUserId, packageId, type);

    res.json({
      success: true,
      data: {
        canRate: result.allowed,
        reason: result.reason
      }
    });
  } catch (error) {
    console.error('Erreur lors de la vérification des permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la vérification'
    });
  }
});

/**
 * @route GET /api/ratings/package/:packageId/existing
 * @desc Vérifier si une évaluation existe déjà
 * @access Private
 */
router.get('/package/:packageId/existing', [
  auth,
  param('packageId').isInt().withMessage('ID colis invalide'),
  query('ratedUserId').isInt().withMessage('ID utilisateur noté requis')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const packageId = parseInt(req.params.packageId);
    const ratedUserId = parseInt(req.query.ratedUserId);
    const raterId = req.user.id;

    const existingRating = await ratingService.getRating(raterId, ratedUserId, packageId);

    res.json({
      success: true,
      data: {
        hasRating: !!existingRating,
        rating: existingRating ? {
          id: existingRating.id,
          rating: existingRating.rating,
          comment: existingRating.comment,
          createdAt: existingRating.created_at
        } : null
      }
    });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'évaluation existante:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la vérification'
    });
  }
});

/**
 * @route DELETE /api/ratings/:ratingId
 * @desc Supprimer une évaluation (admin uniquement)
 * @access Private (Admin)
 */
router.delete('/:ratingId', [
  auth,
  param('ratingId').isInt().withMessage('ID évaluation invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const ratingId = parseInt(req.params.ratingId);
    const adminId = req.user.id;

    const result = await ratingService.deleteRating(ratingId, adminId);

    res.json({
      success: true,
      message: 'Évaluation supprimée avec succès'
    });
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'évaluation:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la suppression de l\'évaluation'
    });
  }
});

/**
 * @route GET /api/ratings/top-rated
 * @desc Obtenir les utilisateurs les mieux notés
 * @access Public
 */
router.get('/top-rated', [
  query('type').optional().isIn(['sender', 'traveler', 'all']).withMessage('Type invalide'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limite invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const type = req.query.type || 'all';
    const limit = parseInt(req.query.limit) || 10;

    const db = require('../config/database');
    let whereClause = '';
    
    if (type !== 'all') {
      whereClause = `WHERE r.rating_type = '${type}'`;
    }

    const query = `
      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.profile_picture,
        u.rating_average,
        u.rating_count,
        COUNT(r.id) as total_ratings,
        AVG(r.rating)::DECIMAL(3,2) as avg_rating
      FROM users u
      LEFT JOIN user_ratings r ON u.id = r.rated_user_id
      ${whereClause}
      GROUP BY u.id, u.first_name, u.last_name, u.profile_picture, u.rating_average, u.rating_count
      HAVING COUNT(r.id) >= 3
      ORDER BY avg_rating DESC, total_ratings DESC
      LIMIT $1
    `;

    const result = await db.query(query, [limit]);

    res.json({
      success: true,
      data: {
        topRatedUsers: result.rows.map(user => ({
          id: user.id,
          firstName: user.first_name,
          lastName: user.last_name,
          profilePicture: user.profile_picture,
          averageRating: parseFloat(user.avg_rating) || 0,
          totalRatings: parseInt(user.total_ratings)
        }))
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des utilisateurs les mieux notés:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération'
    });
  }
});

module.exports = router;