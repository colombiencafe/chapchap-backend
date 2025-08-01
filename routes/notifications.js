const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const notificationService = require('../services/notificationService');

/**
 * @route POST /api/notifications/register-token
 * @desc Enregistrer un token FCM pour les notifications push
 * @access Private
 */
router.post('/register-token', [
  auth,
  body('fcmToken').notEmpty().withMessage('Token FCM requis'),
  body('deviceType').optional().isIn(['android', 'ios', 'web']).withMessage('Type de dispositif invalide')
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

    const { fcmToken, deviceType = 'web' } = req.body;
    const userId = req.user.id;

    const result = await notificationService.registerFCMToken(userId, fcmToken, deviceType);

    res.json({
      success: true,
      message: 'Token FCM enregistré avec succès',
      data: result
    });
  } catch (error) {
    console.error('Erreur lors de l\'enregistrement du token FCM:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de l\'enregistrement du token'
    });
  }
});

/**
 * @route DELETE /api/notifications/unregister-token
 * @desc Supprimer un token FCM
 * @access Private
 */
router.delete('/unregister-token', [
  auth,
  body('fcmToken').notEmpty().withMessage('Token FCM requis')
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

    const { fcmToken } = req.body;
    const userId = req.user.id;

    const result = await notificationService.unregisterFCMToken(userId, fcmToken);

    res.json({
      success: true,
      message: 'Token FCM supprimé avec succès',
      data: result
    });
  } catch (error) {
    console.error('Erreur lors de la suppression du token FCM:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression du token'
    });
  }
});

/**
 * @route GET /api/notifications/tokens
 * @desc Obtenir les tokens FCM de l'utilisateur
 * @access Private
 */
router.get('/tokens', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const tokens = await notificationService.getUserFCMTokens(userId);

    res.json({
      success: true,
      data: {
        tokens: tokens.map(token => ({
          deviceType: token.device_type,
          tokenPreview: token.fcm_token.substring(0, 20) + '...'
        }))
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des tokens FCM:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des tokens'
    });
  }
});

/**
 * @route POST /api/notifications/test
 * @desc Envoyer une notification de test
 * @access Private
 */
router.post('/test', [
  auth,
  body('title').notEmpty().withMessage('Titre requis'),
  body('body').notEmpty().withMessage('Corps du message requis')
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

    const { title, body, data = {} } = req.body;
    const userId = req.user.id;

    const notification = {
      title,
      body,
      type: 'test',
      icon: '/icons/test.png',
      data
    };

    const result = await notificationService.sendPushNotification(userId, notification);

    res.json({
      success: true,
      message: 'Notification de test envoyée',
      data: result
    });
  } catch (error) {
    console.error('Erreur lors de l\'envoi de la notification de test:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de l\'envoi de la notification'
    });
  }
});

/**
 * @route GET /api/notifications/preferences
 * @desc Obtenir les préférences de notification de l'utilisateur
 * @access Private
 */
router.get('/preferences', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Récupérer les préférences depuis la base de données
    const db = require('../config/database');
    const query = `
      SELECT 
        notification_packages,
        notification_trips,
        notification_messages,
        notification_location,
        notification_disputes,
        notification_marketing
      FROM users 
      WHERE id = $1
    `;
    
    const result = await db.query(query, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    const preferences = result.rows[0];

    res.json({
      success: true,
      data: {
        preferences: {
          packages: preferences.notification_packages ?? true,
          trips: preferences.notification_trips ?? true,
          messages: preferences.notification_messages ?? true,
          location: preferences.notification_location ?? true,
          disputes: preferences.notification_disputes ?? true,
          marketing: preferences.notification_marketing ?? false
        }
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des préférences:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des préférences'
    });
  }
});

/**
 * @route PUT /api/notifications/preferences
 * @desc Mettre à jour les préférences de notification
 * @access Private
 */
router.put('/preferences', [
  auth,
  body('packages').optional().isBoolean().withMessage('Préférence packages doit être un booléen'),
  body('trips').optional().isBoolean().withMessage('Préférence trips doit être un booléen'),
  body('messages').optional().isBoolean().withMessage('Préférence messages doit être un booléen'),
  body('location').optional().isBoolean().withMessage('Préférence location doit être un booléen'),
  body('disputes').optional().isBoolean().withMessage('Préférence disputes doit être un booléen'),
  body('marketing').optional().isBoolean().withMessage('Préférence marketing doit être un booléen')
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

    const userId = req.user.id;
    const { packages, trips, messages, location, disputes, marketing } = req.body;

    const db = require('../config/database');
    const updateFields = [];
    const values = [userId];
    let paramIndex = 2;

    if (packages !== undefined) {
      updateFields.push(`notification_packages = $${paramIndex}`);
      values.push(packages);
      paramIndex++;
    }
    if (trips !== undefined) {
      updateFields.push(`notification_trips = $${paramIndex}`);
      values.push(trips);
      paramIndex++;
    }
    if (messages !== undefined) {
      updateFields.push(`notification_messages = $${paramIndex}`);
      values.push(messages);
      paramIndex++;
    }
    if (location !== undefined) {
      updateFields.push(`notification_location = $${paramIndex}`);
      values.push(location);
      paramIndex++;
    }
    if (disputes !== undefined) {
      updateFields.push(`notification_disputes = $${paramIndex}`);
      values.push(disputes);
      paramIndex++;
    }
    if (marketing !== undefined) {
      updateFields.push(`notification_marketing = $${paramIndex}`);
      values.push(marketing);
      paramIndex++;
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Aucune préférence à mettre à jour'
      });
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');

    const query = `
      UPDATE users 
      SET ${updateFields.join(', ')}
      WHERE id = $1
      RETURNING 
        notification_packages,
        notification_trips,
        notification_messages,
        notification_location,
        notification_disputes,
        notification_marketing
    `;

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    const updatedPreferences = result.rows[0];

    res.json({
      success: true,
      message: 'Préférences mises à jour avec succès',
      data: {
        preferences: {
          packages: updatedPreferences.notification_packages,
          trips: updatedPreferences.notification_trips,
          messages: updatedPreferences.notification_messages,
          location: updatedPreferences.notification_location,
          disputes: updatedPreferences.notification_disputes,
          marketing: updatedPreferences.notification_marketing
        }
      }
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour des préférences:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour des préférences'
    });
  }
});

module.exports = router;