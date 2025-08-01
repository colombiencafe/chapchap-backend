const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const geolocationService = require('../services/geolocationService');

const router = express.Router();

/**
 * Routes de géolocalisation ChapChap
 * Suivi en temps réel des voyageurs
 */

// Validation pour démarrer le suivi
const startTrackingValidation = [
  param('tripId').isInt({ min: 1 }).withMessage('ID de voyage invalide'),
  body('updateInterval')
    .optional()
    .isInt({ min: 10000, max: 300000 })
    .withMessage('Intervalle de mise à jour doit être entre 10s et 5min'),
  body('accuracy')
    .optional()
    .isIn(['high', 'medium', 'low'])
    .withMessage('Précision doit être high, medium ou low'),
  body('shareWithSenders')
    .optional()
    .isBoolean()
    .withMessage('shareWithSenders doit être un booléen')
];

// Validation pour mise à jour de position
const updateLocationValidation = [
  body('latitude')
    .isFloat({ min: -90, max: 90 })
    .withMessage('Latitude invalide (-90 à 90)'),
  body('longitude')
    .isFloat({ min: -180, max: 180 })
    .withMessage('Longitude invalide (-180 à 180)'),
  body('accuracy')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Précision doit être positive'),
  body('speed')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Vitesse doit être positive'),
  body('heading')
    .optional()
    .isFloat({ min: 0, max: 360 })
    .withMessage('Direction doit être entre 0 et 360 degrés')
];

/**
 * @route POST /api/geolocation/trips/:tripId/start-tracking
 * @desc Démarrer le suivi de géolocalisation pour un voyage
 * @access Private (Voyageur uniquement)
 */
router.post('/trips/:tripId/start-tracking', startTrackingValidation, auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    const { tripId } = req.params;
    const userId = req.user.userId;
    const options = req.body;

    const result = await geolocationService.startTracking(
      userId,
      parseInt(tripId),
      options
    );

    res.json({
      success: true,
      message: result.message,
      data: {
        trackingId: result.trackingId,
        updateInterval: result.updateInterval,
        tripId: parseInt(tripId)
      }
    });

  } catch (error) {
    console.error('Erreur lors du démarrage du suivi:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors du démarrage du suivi'
    });
  }
});

/**
 * @route PUT /api/geolocation/location
 * @desc Mettre à jour la position du voyageur
 * @access Private (Voyageur avec suivi actif)
 */
router.put('/location', updateLocationValidation, auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Données de localisation invalides',
        errors: errors.array()
      });
    }

    const userId = req.user.userId;
    const location = req.body;

    const result = await geolocationService.updateLocation(userId, location);

    res.json({
      success: true,
      message: result.message,
      data: {
        location: result.location,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour de position:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la mise à jour de position'
    });
  }
});

/**
 * @route POST /api/geolocation/stop-tracking
 * @desc Arrêter le suivi de géolocalisation
 * @access Private (Voyageur avec suivi actif)
 */
router.post('/stop-tracking', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await geolocationService.stopTracking(userId);

    res.json({
      success: true,
      message: result.message
    });

  } catch (error) {
    console.error('Erreur lors de l\'arrêt du suivi:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de l\'arrêt du suivi'
    });
  }
});

/**
 * @route GET /api/geolocation/trips/:tripId/current-location
 * @desc Obtenir la position actuelle d'un voyage
 * @access Private (Voyageur ou expéditeur autorisé)
 */
router.get('/trips/:tripId/current-location', [
  param('tripId').isInt({ min: 1 }).withMessage('ID de voyage invalide')
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'ID de voyage invalide',
        errors: errors.array()
      });
    }

    const { tripId } = req.params;
    const userId = req.user.userId;

    const result = await geolocationService.getCurrentLocation(
      parseInt(tripId),
      userId
    );

    if (!result.success) {
      return res.status(404).json(result);
    }

    res.json({
      success: true,
      data: result.data
    });

  } catch (error) {
    console.error('Erreur lors de la récupération de position:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la récupération de position'
    });
  }
});

/**
 * @route GET /api/geolocation/trips/:tripId/history
 * @desc Obtenir l'historique de trajet
 * @access Private (Voyageur ou expéditeur autorisé)
 */
router.get('/trips/:tripId/history', [
  param('tripId').isInt({ min: 1 }).withMessage('ID de voyage invalide'),
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
  query('from').optional().isISO8601().withMessage('Date de début invalide'),
  query('to').optional().isISO8601().withMessage('Date de fin invalide')
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres invalides',
        errors: errors.array()
      });
    }

    const { tripId } = req.params;
    const userId = req.user.userId;

    const result = await geolocationService.getTripHistory(
      parseInt(tripId),
      userId
    );

    res.json({
      success: true,
      data: result.data
    });

  } catch (error) {
    console.error('Erreur lors de la récupération de l\'historique:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la récupération de l\'historique'
    });
  }
});

/**
 * @route GET /api/geolocation/stats
 * @desc Obtenir les statistiques de suivi de l'utilisateur
 * @access Private
 */
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await geolocationService.getTrackingStats(userId);

    res.json({
      success: true,
      data: result.data
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques'
    });
  }
});

/**
 * @route GET /api/geolocation/active-trips
 * @desc Obtenir les voyages avec suivi actif
 * @access Private
 */
router.get('/active-trips', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const activeTripsQuery = `
      SELECT 
        t.id, t.departure_city, t.destination_city, t.departure_date, t.status,
        tt.start_time, tt.update_interval, tt.share_with_senders,
        (
          SELECT COUNT(*) FROM trip_locations tl WHERE tl.tracking_id = tt.id
        ) as location_points,
        (
          SELECT tl.recorded_at FROM trip_locations tl 
          WHERE tl.tracking_id = tt.id 
          ORDER BY tl.recorded_at DESC LIMIT 1
        ) as last_update
      FROM trips t
      JOIN trip_tracking tt ON t.id = tt.trip_id
      WHERE (t.traveler_id = $1 OR EXISTS (
        SELECT 1 FROM packages p WHERE p.trip_id = t.id AND p.sender_id = $1
      ))
        AND tt.status = 'active'
      ORDER BY tt.start_time DESC
    `;

    const result = await require('../config/database').query(activeTripsQuery, [userId]);

    res.json({
      success: true,
      data: {
        activeTrips: result.rows,
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des voyages actifs:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des voyages actifs'
    });
  }
});

/**
 * @route POST /api/geolocation/permissions/:tripId
 * @desc Modifier les permissions de partage de localisation
 * @access Private (Voyageur uniquement)
 */
router.post('/permissions/:tripId', [
  param('tripId').isInt({ min: 1 }).withMessage('ID de voyage invalide'),
  body('shareWithSenders').isBoolean().withMessage('shareWithSenders doit être un booléen')
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    const { tripId } = req.params;
    const { shareWithSenders } = req.body;
    const userId = req.user.userId;

    // Vérifier que l'utilisateur est le voyageur
    const tripQuery = `
      SELECT id FROM trips WHERE id = $1 AND traveler_id = $2
    `;
    
    const tripResult = await require('../config/database').query(tripQuery, [tripId, userId]);
    
    if (tripResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Permission refusée - vous n\'êtes pas le voyageur de ce trajet'
      });
    }

    // Mettre à jour les permissions
    const updateQuery = `
      UPDATE trip_tracking 
      SET share_with_senders = $1
      WHERE trip_id = $2 AND status = 'active'
    `;
    
    await require('../config/database').query(updateQuery, [shareWithSenders, tripId]);

    res.json({
      success: true,
      message: 'Permissions de partage mises à jour',
      data: {
        tripId: parseInt(tripId),
        shareWithSenders
      }
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour des permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour des permissions'
    });
  }
});

/**
 * @route GET /api/geolocation/nearby-packages
 * @desc Trouver les colis à proximité de la position actuelle
 * @access Private (Voyageur)
 */
router.get('/nearby-packages', [
  query('latitude').isFloat({ min: -90, max: 90 }).withMessage('Latitude invalide'),
  query('longitude').isFloat({ min: -180, max: 180 }).withMessage('Longitude invalide'),
  query('radius').optional().isFloat({ min: 0.1, max: 100 }).withMessage('Rayon doit être entre 0.1 et 100 km')
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres de localisation invalides',
        errors: errors.array()
      });
    }

    const { latitude, longitude, radius = 5 } = req.query;
    const userId = req.user.userId;

    // Recherche de colis à proximité (approximation simple)
    const nearbyQuery = `
      SELECT 
        p.id, p.title, p.description, p.pickup_address, p.delivery_address,
        p.weight, p.size, p.price, p.status,
        t.departure_city, t.destination_city, t.departure_date,
        u.first_name as sender_name
      FROM packages p
      JOIN trips t ON p.trip_id = t.id
      JOIN users u ON p.sender_id = u.id
      WHERE p.status = 'requested'
        AND t.traveler_id IS NULL
        AND p.sender_id != $1
      ORDER BY p.created_at DESC
      LIMIT 20
    `;

    const result = await require('../config/database').query(nearbyQuery, [userId]);

    res.json({
      success: true,
      data: {
        packages: result.rows,
        searchLocation: {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          radius: parseFloat(radius)
        },
        total: result.rows.length
      }
    });

  } catch (error) {
    console.error('Erreur lors de la recherche de colis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la recherche de colis à proximité'
    });
  }
});

module.exports = router;