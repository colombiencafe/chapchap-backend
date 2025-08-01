const express = require('express');
const router = express.Router();
const { param, query, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const analyticsService = require('../services/analyticsService');

/**
 * @route GET /api/analytics/user/:userId
 * @desc Obtenir les statistiques d'un utilisateur
 * @access Private
 */
router.get('/user/:userId', [
  auth,
  param('userId').isInt().withMessage('ID utilisateur invalide'),
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide')
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
    const period = req.query.period || '30d';
    const requesterId = req.user.id;

    // Vérifier que l'utilisateur peut accéder à ces statistiques
    if (userId !== requesterId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé à ces statistiques'
      });
    }

    const result = await analyticsService.getUserStats(userId, period);

    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des statistiques'
    });
  }
});

/**
 * @route GET /api/analytics/my-stats
 * @desc Obtenir les statistiques de l'utilisateur connecté
 * @access Private
 */
router.get('/my-stats', [
  auth,
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide')
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

    const userId = req.user.id;
    const period = req.query.period || '30d';

    const result = await analyticsService.getUserStats(userId, period);

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
 * @route GET /api/analytics/disputes
 * @desc Obtenir les statistiques de litiges de l'utilisateur
 * @access Private
 */
router.get('/disputes', [
  auth,
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide')
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

    const userId = req.user.id;
    const period = req.query.period || '30d';

    const result = await analyticsService.getDisputeStats(userId, period);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques de litiges:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des statistiques'
    });
  }
});

/**
 * @route GET /api/analytics/platform
 * @desc Obtenir les statistiques globales de la plateforme (admin uniquement)
 * @access Private (Admin)
 */
router.get('/platform', [
  auth,
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide')
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

    // Vérifier que l'utilisateur est admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès réservé aux administrateurs'
      });
    }

    const period = req.query.period || '30d';
    const result = await analyticsService.getPlatformStats(period);

    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques de la plateforme:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des statistiques'
    });
  }
});

/**
 * @route GET /api/analytics/trends
 * @desc Obtenir les tendances temporelles
 * @access Private (Admin)
 */
router.get('/trends', [
  auth,
  query('metric').isIn(['packages', 'trips', 'users', 'revenue']).withMessage('Métrique invalide'),
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide'),
  query('granularity').optional().isIn(['day', 'week', 'month']).withMessage('Granularité invalide')
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

    // Vérifier que l'utilisateur est admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès réservé aux administrateurs'
      });
    }

    const metric = req.query.metric;
    const period = req.query.period || '30d';
    const granularity = req.query.granularity || 'day';

    const result = await analyticsService.getTimeTrends(metric, period, granularity);

    res.json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des tendances:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des tendances'
    });
  }
});

/**
 * @route GET /api/analytics/summary
 * @desc Obtenir un résumé rapide des statistiques utilisateur
 * @access Private
 */
router.get('/summary', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Récupérer les statistiques de base
    const result = await analyticsService.getUserStats(userId, '30d');
    
    // Créer un résumé simplifié
    const summary = {
      packages: {
        sent: result.data.packages.sent,
        delivered: result.data.packages.delivered,
        totalEarned: result.data.financial.totalEarned
      },
      trips: {
        total: result.data.trips.total,
        completed: result.data.trips.completed,
        completionRate: result.data.trips.completionRate
      },
      rating: {
        average: result.data.ratings.averageRating,
        total: result.data.ratings.totalRatings
      },
      period: '30d'
    };

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du résumé:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération du résumé'
    });
  }
});

/**
 * @route GET /api/analytics/performance
 * @desc Obtenir les métriques de performance de l'utilisateur
 * @access Private
 */
router.get('/performance', [
  auth,
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide')
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

    const userId = req.user.id;
    const period = req.query.period || '30d';

    const [userStats, disputeStats] = await Promise.all([
      analyticsService.getUserStats(userId, period),
      analyticsService.getDisputeStats(userId, period)
    ]);

    const performance = {
      reliability: {
        tripCompletionRate: userStats.data.trips.completionRate,
        disputeRate: userStats.data.packages.total > 0 ? 
          (disputeStats.total / userStats.data.packages.total * 100).toFixed(2) : 0,
        averageRating: userStats.data.ratings.averageRating
      },
      activity: {
        packagesPerMonth: userStats.data.packages.total,
        tripsPerMonth: userStats.data.trips.total,
        responseTime: 'N/A' // À implémenter avec les données de messages
      },
      financial: {
        averageEarningsPerTrip: userStats.data.trips.completed > 0 ? 
          (userStats.data.financial.totalEarned / userStats.data.trips.completed).toFixed(2) : 0,
        totalRevenue: userStats.data.financial.totalEarned,
        profitMargin: userStats.data.financial.totalEarned > 0 ? 
          ((userStats.data.financial.totalEarned - userStats.data.financial.totalSpent) / userStats.data.financial.totalEarned * 100).toFixed(2) : 0
      },
      period
    };

    res.json({
      success: true,
      data: performance
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des métriques de performance:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des métriques'
    });
  }
});

/**
 * @route GET /api/analytics/leaderboard
 * @desc Obtenir le classement des utilisateurs (public)
 * @access Public
 */
router.get('/leaderboard', [
  query('type').optional().isIn(['rating', 'deliveries', 'revenue']).withMessage('Type de classement invalide'),
  query('period').optional().isIn(['7d', '30d', '90d', '1y', 'all']).withMessage('Période invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limite invalide')
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

    const type = req.query.type || 'rating';
    const period = req.query.period || '30d';
    const limit = parseInt(req.query.limit) || 10;

    const db = require('../config/database');
    const dateFilter = analyticsService.getDateFilter(period);
    
    let query, orderBy;
    
    switch (type) {
      case 'rating':
        orderBy = 'u.rating_average DESC, u.rating_count DESC';
        break;
      case 'deliveries':
        orderBy = 'delivery_count DESC';
        break;
      case 'revenue':
        orderBy = 'total_revenue DESC';
        break;
      default:
        orderBy = 'u.rating_average DESC';
    }

    if (type === 'deliveries') {
      query = `
        SELECT 
          u.id,
          u.first_name,
          u.last_name,
          u.profile_picture,
          u.rating_average,
          u.rating_count,
          COUNT(p.id) as delivery_count
        FROM users u
        LEFT JOIN packages p ON u.id = p.traveler_id
        ${dateFilter ? `AND ${dateFilter.replace('created_at', 'p.created_at')}` : ''}
        GROUP BY u.id, u.first_name, u.last_name, u.profile_picture, u.rating_average, u.rating_count
        HAVING COUNT(p.id) > 0
        ORDER BY ${orderBy}
        LIMIT $1
      `;
    } else if (type === 'revenue') {
      query = `
        SELECT 
          u.id,
          u.first_name,
          u.last_name,
          u.profile_picture,
          u.rating_average,
          u.rating_count,
          SUM(p.price)::DECIMAL(10,2) as total_revenue
        FROM users u
        LEFT JOIN packages p ON u.id = p.traveler_id
        ${dateFilter ? `AND ${dateFilter.replace('created_at', 'p.created_at')}` : ''}
        GROUP BY u.id, u.first_name, u.last_name, u.profile_picture, u.rating_average, u.rating_count
        HAVING SUM(p.price) > 0
        ORDER BY ${orderBy}
        LIMIT $1
      `;
    } else {
      query = `
        SELECT 
          u.id,
          u.first_name,
          u.last_name,
          u.profile_picture,
          u.rating_average,
          u.rating_count
        FROM users u
        WHERE u.rating_count >= 3
        ORDER BY ${orderBy}
        LIMIT $1
      `;
    }

    const result = await db.query(query, [limit]);

    const leaderboard = result.rows.map((user, index) => ({
      rank: index + 1,
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      profilePicture: user.profile_picture,
      averageRating: parseFloat(user.rating_average) || 0,
      totalRatings: parseInt(user.rating_count) || 0,
      deliveryCount: parseInt(user.delivery_count) || 0,
      totalRevenue: parseFloat(user.total_revenue) || 0
    }));

    res.json({
      success: true,
      data: {
        type,
        period,
        leaderboard
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du classement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération du classement'
    });
  }
});

module.exports = router;