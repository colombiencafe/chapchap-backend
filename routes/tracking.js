const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const { TrackingService, PACKAGE_STATUS } = require('../services/trackingService');
const fileService = require('../services/fileService');
const path = require('path');

const router = express.Router();

/**
 * Routes de suivi des colis ChapChap
 * Gestion des statuts, notifications et litiges
 */

// Validation pour la mise à jour de statut
const updateStatusValidation = [
  param('packageId').isInt({ min: 1 }).withMessage('ID de colis invalide'),
  body('status')
    .isIn(Object.values(PACKAGE_STATUS))
    .withMessage('Statut invalide'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Les notes ne peuvent pas dépasser 500 caractères'),
  body('location')
    .optional()
    .trim()
    .isLength({ max: 255 })
    .withMessage('La localisation ne peut pas dépasser 255 caractères')
];

// Validation pour la création de litige
const createDisputeValidation = [
  param('packageId').isInt({ min: 1 }).withMessage('ID de colis invalide'),
  body('reason')
    .trim()
    .isLength({ min: 5, max: 100 })
    .withMessage('La raison doit contenir entre 5 et 100 caractères'),
  body('description')
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('La description doit contenir entre 10 et 1000 caractères')
];

/**
 * @route PUT /api/tracking/:packageId/status
 * @desc Mettre à jour le statut d'un colis
 * @access Private
 */
router.put('/:packageId/status', updateStatusValidation, auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    const { packageId } = req.params;
    const { status, notes, location } = req.body;
    const userId = req.user.userId;

    // Traiter l'upload de photo si présent
    let photoPath = null;
    if (req.files && req.files.photo) {
      const uploadResult = await fileService.processTrackingPhotoUpload(req.files.photo);
      if (uploadResult.success) {
        photoPath = uploadResult.filePath;
      }
    }

    const result = await TrackingService.updatePackageStatus(
      parseInt(packageId),
      status,
      userId,
      { notes, location, photoPath }
    );

    res.json({
      success: true,
      message: 'Statut mis à jour avec succès',
      data: result
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la mise à jour du statut'
    });
  }
});

/**
 * @route GET /api/tracking/:packageId/history
 * @desc Obtenir l'historique de suivi d'un colis
 * @access Private
 */
router.get('/:packageId/history', [
  param('packageId').isInt({ min: 1 }).withMessage('ID de colis invalide')
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'ID de colis invalide',
        errors: errors.array()
      });
    }

    const { packageId } = req.params;
    const userId = req.user.userId;

    const history = await TrackingService.getPackageTracking(
      parseInt(packageId),
      userId
    );

    res.json({
      success: true,
      data: {
        packageId: parseInt(packageId),
        history
      }
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
 * @route POST /api/tracking/:packageId/dispute
 * @desc Déclarer un litige pour un colis
 * @access Private
 */
router.post('/:packageId/dispute', createDisputeValidation, auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    const { packageId } = req.params;
    const { reason, description } = req.body;
    const userId = req.user.userId;

    // Traiter les photos de preuve si présentes
    let evidencePhotos = [];
    if (req.files && req.files.evidence) {
      const files = Array.isArray(req.files.evidence) ? req.files.evidence : [req.files.evidence];
      
      for (const file of files) {
        const uploadResult = await fileService.processDisputePhotoUpload(file);
        if (uploadResult.success) {
          evidencePhotos.push({
            path: uploadResult.filePath,
            originalName: uploadResult.originalName,
            size: uploadResult.size
          });
        }
      }
    }

    const result = await TrackingService.createDispute(
      parseInt(packageId),
      userId,
      { reason, description, evidencePhotos }
    );

    res.json({
      success: true,
      message: result.message,
      data: {
        disputeId: result.disputeId,
        packageId: parseInt(packageId)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du litige:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la création du litige'
    });
  }
});

/**
 * @route GET /api/tracking/stats
 * @desc Obtenir les statistiques de suivi de l'utilisateur
 * @access Private
 */
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const stats = await TrackingService.getTrackingStats(userId);

    res.json({
      success: true,
      data: stats
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
 * @route GET /api/tracking/status-options
 * @desc Obtenir les options de statut disponibles
 * @access Private
 */
router.get('/status-options', auth, async (req, res) => {
  try {
    const { currentStatus } = req.query;
    
    const { ALLOWED_TRANSITIONS, STATUS_MESSAGES } = require('../services/trackingService');
    
    let availableStatuses = [];
    if (currentStatus && ALLOWED_TRANSITIONS[currentStatus]) {
      availableStatuses = ALLOWED_TRANSITIONS[currentStatus].map(status => ({
        value: status,
        ...STATUS_MESSAGES[status]
      }));
    }

    res.json({
      success: true,
      data: {
        currentStatus,
        availableStatuses,
        allStatuses: Object.keys(STATUS_MESSAGES).map(status => ({
          value: status,
          ...STATUS_MESSAGES[status]
        }))
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des options:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des options'
    });
  }
});

/**
 * @route GET /api/tracking/packages/active
 * @desc Obtenir les colis actifs de l'utilisateur avec leur statut
 * @access Private
 */
router.get('/packages/active', [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt()
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

    const userId = req.user.userId;
    const page = req.query.page || 1;
    const limit = req.query.limit || 10;
    const offset = (page - 1) * limit;

    const packagesQuery = `
      SELECT 
        p.*,
        t.departure_city, t.destination_city, t.departure_date, t.arrival_date,
        u_sender.first_name as sender_name,
        u_traveler.first_name as traveler_name,
        (
          SELECT json_agg(
            json_build_object(
              'id', pt.id,
              'status', pt.status,
              'notes', pt.notes,
              'location', pt.location,
              'created_at', pt.created_at
            ) ORDER BY pt.created_at DESC
          )
          FROM package_tracking pt 
          WHERE pt.package_id = p.id
        ) as tracking_history
      FROM packages p
      JOIN trips t ON p.trip_id = t.id
      JOIN users u_sender ON p.sender_id = u_sender.id
      LEFT JOIN users u_traveler ON t.traveler_id = u_traveler.id
      WHERE (p.sender_id = $1 OR t.traveler_id = $1)
        AND p.status NOT IN ('delivered', 'cancelled')
      ORDER BY p.updated_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM packages p
      JOIN trips t ON p.trip_id = t.id
      WHERE (p.sender_id = $1 OR t.traveler_id = $1)
        AND p.status NOT IN ('delivered', 'cancelled')
    `;

    const [packagesResult, countResult] = await Promise.all([
      require('../config/database').query(packagesQuery, [userId, limit, offset]),
      require('../config/database').query(countQuery, [userId])
    ]);

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        packages: packagesResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des colis actifs:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des colis actifs'
    });
  }
});

/**
 * @route GET /api/tracking/disputes
 * @desc Obtenir les litiges de l'utilisateur
 * @access Private
 */
router.get('/disputes', [
  query('status').optional().isIn(['open', 'investigating', 'resolved', 'closed']),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt()
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

    const userId = req.user.userId;
    const status = req.query.status;
    const page = req.query.page || 1;
    const limit = req.query.limit || 10;
    const offset = (page - 1) * limit;

    let whereClause = `
      WHERE (p.sender_id = $1 OR t.traveler_id = $1)
    `;
    let queryParams = [userId];

    if (status) {
      whereClause += ` AND pd.status = $${queryParams.length + 1}`;
      queryParams.push(status);
    }

    const disputesQuery = `
      SELECT 
        pd.*,
        p.title as package_title,
        p.status as package_status,
        u_reporter.first_name as reporter_name,
        u_resolver.first_name as resolver_name
      FROM package_disputes pd
      JOIN packages p ON pd.package_id = p.id
      JOIN trips t ON p.trip_id = t.id
      JOIN users u_reporter ON pd.reporter_id = u_reporter.id
      LEFT JOIN users u_resolver ON pd.resolved_by = u_resolver.id
      ${whereClause}
      ORDER BY pd.created_at DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;

    queryParams.push(limit, offset);

    const result = await require('../config/database').query(disputesQuery, queryParams);

    res.json({
      success: true,
      data: {
        disputes: result.rows,
        pagination: {
          page,
          limit,
          hasNext: result.rows.length === limit,
          hasPrev: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des litiges:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des litiges'
    });
  }
});

module.exports = router;