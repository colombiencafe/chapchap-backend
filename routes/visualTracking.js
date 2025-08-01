const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const visualTrackingService = require('../services/visualTrackingService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configuration de multer pour l'upload de photos
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/tracking';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'tracking-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées (JPEG, PNG, GIF, WebP)'));
    }
  }
});

/**
 * @route POST /api/visual-tracking/packages/:packageId/steps
 * @desc Créer une nouvelle étape de suivi pour un colis
 * @access Private
 */
router.post('/packages/:packageId/steps', [
  auth,
  upload.single('photo'),
  param('packageId').isInt().withMessage('ID de colis invalide'),
  body('status').notEmpty().withMessage('Statut requis'),
  body('description').isLength({ min: 5, max: 500 }).withMessage('Description entre 5 et 500 caractères'),
  body('location').optional().isLength({ max: 255 }).withMessage('Localisation trop longue')
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

    const packageId = parseInt(req.params.packageId);
    const { status, description, location } = req.body;
    const userId = req.user.id;
    const photoUrl = req.file ? `/uploads/tracking/${req.file.filename}` : null;

    const result = await visualTrackingService.createTrackingStep(
      packageId, status, description, location, photoUrl, userId
    );

    res.status(201).json(result);
  } catch (error) {
    console.error('Erreur lors de la création de l\'étape de suivi:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la création de l\'étape'
    });
  }
});

/**
 * @route GET /api/visual-tracking/packages/:packageId/timeline
 * @desc Obtenir la timeline complète d'un colis
 * @access Private
 */
router.get('/packages/:packageId/timeline', [
  auth,
  param('packageId').isInt().withMessage('ID de colis invalide')
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
    const userId = req.user.id;

    const result = await visualTrackingService.getPackageTimeline(packageId, userId);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la récupération de la timeline:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la récupération de la timeline'
    });
  }
});

/**
 * @route GET /api/visual-tracking/packages/:packageId/photos
 * @desc Obtenir toutes les photos d'un colis
 * @access Private
 */
router.get('/packages/:packageId/photos', [
  auth,
  param('packageId').isInt().withMessage('ID de colis invalide')
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
    const userId = req.user.id;

    const result = await visualTrackingService.getPackagePhotos(packageId, userId);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la récupération des photos:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la récupération des photos'
    });
  }
});

/**
 * @route GET /api/visual-tracking/recent-steps
 * @desc Obtenir les étapes de suivi récentes de l'utilisateur
 * @access Private
 */
router.get('/recent-steps', [
  auth,
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

    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    const result = await visualTrackingService.getRecentTrackingSteps(userId, limit);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la récupération des étapes récentes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des étapes'
    });
  }
});

/**
 * @route PUT /api/visual-tracking/steps/:stepId
 * @desc Mettre à jour une étape de suivi
 * @access Private
 */
router.put('/steps/:stepId', [
  auth,
  upload.single('photo'),
  param('stepId').isInt().withMessage('ID d\'étape invalide'),
  body('description').optional().isLength({ min: 5, max: 500 }).withMessage('Description entre 5 et 500 caractères'),
  body('location').optional().isLength({ max: 255 }).withMessage('Localisation trop longue')
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

    const stepId = parseInt(req.params.stepId);
    const userId = req.user.id;
    const updates = {};

    // Ajouter les champs à mettre à jour
    if (req.body.description) updates.description = req.body.description;
    if (req.body.location) updates.location = req.body.location;
    if (req.file) updates.photo_url = `/uploads/tracking/${req.file.filename}`;

    const result = await visualTrackingService.updateTrackingStep(stepId, updates, userId);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'étape:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la mise à jour'
    });
  }
});

/**
 * @route DELETE /api/visual-tracking/steps/:stepId
 * @desc Supprimer une étape de suivi
 * @access Private
 */
router.delete('/steps/:stepId', [
  auth,
  param('stepId').isInt().withMessage('ID d\'étape invalide')
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

    const stepId = parseInt(req.params.stepId);
    const userId = req.user.id;

    const result = await visualTrackingService.deleteTrackingStep(stepId, userId);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'étape:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la suppression'
    });
  }
});

/**
 * @route GET /api/visual-tracking/packages/:packageId/status/:status
 * @desc Obtenir les étapes de suivi par statut
 * @access Private
 */
router.get('/packages/:packageId/status/:status', [
  auth,
  param('packageId').isInt().withMessage('ID de colis invalide'),
  param('status').notEmpty().withMessage('Statut requis')
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
    const status = req.params.status;
    const userId = req.user.id;

    const result = await visualTrackingService.getTrackingStepsByStatus(packageId, status, userId);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la récupération des étapes par statut:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la récupération'
    });
  }
});

/**
 * @route GET /api/visual-tracking/stats
 * @desc Obtenir les statistiques de suivi de l'utilisateur
 * @access Private
 */
router.get('/stats', [
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

    const result = await visualTrackingService.getTrackingStats(userId, period);

    res.json(result);
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des statistiques'
    });
  }
});

/**
 * @route GET /api/visual-tracking/packages/:packageId/progress
 * @desc Obtenir le pourcentage de progression d'un colis
 * @access Private
 */
router.get('/packages/:packageId/progress', [
  auth,
  param('packageId').isInt().withMessage('ID de colis invalide')
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
    const userId = req.user.id;

    // Récupérer les informations du colis
    const db = require('../config/database');
    const packageQuery = `
      SELECT status, sender_id, traveler_id
      FROM packages
      WHERE id = $1
    `;
    
    const packageResult = await db.query(packageQuery, [packageId]);
    
    if (packageResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Colis non trouvé'
      });
    }

    const packageData = packageResult.rows[0];
    
    // Vérifier les permissions
    if (packageData.sender_id !== userId && 
        packageData.traveler_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Permission refusée'
      });
    }

    const progress = visualTrackingService.calculateProgress(packageData.status);

    res.json({
      success: true,
      data: {
        packageId,
        status: packageData.status,
        progress,
        progressText: `${progress}% complété`
      }
    });
  } catch (error) {
    console.error('Erreur lors du calcul de la progression:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors du calcul de la progression'
    });
  }
});

/**
 * @route POST /api/visual-tracking/packages/:packageId/quick-update
 * @desc Mise à jour rapide du statut avec photo optionnelle
 * @access Private
 */
router.post('/packages/:packageId/quick-update', [
  auth,
  upload.single('photo'),
  param('packageId').isInt().withMessage('ID de colis invalide'),
  body('status').notEmpty().withMessage('Statut requis'),
  body('description').optional().isLength({ min: 5, max: 500 }).withMessage('Description entre 5 et 500 caractères')
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

    const packageId = parseInt(req.params.packageId);
    const { status } = req.body;
    const userId = req.user.id;
    const photoUrl = req.file ? `/uploads/tracking/${req.file.filename}` : null;
    
    // Descriptions par défaut selon le statut
    const defaultDescriptions = {
      'picked_up': 'Colis récupéré avec succès',
      'in_transit': 'Colis en cours de transport',
      'delivered': 'Colis livré à destination',
      'confirmed': 'Livraison confirmée par le destinataire'
    };
    
    const description = req.body.description || defaultDescriptions[status] || `Statut mis à jour: ${status}`;

    const result = await visualTrackingService.createTrackingStep(
      packageId, status, description, null, photoUrl, userId
    );

    res.status(201).json({
      success: true,
      message: 'Statut mis à jour avec succès',
      data: result.data
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour rapide:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur serveur lors de la mise à jour'
    });
  }
});

module.exports = router;