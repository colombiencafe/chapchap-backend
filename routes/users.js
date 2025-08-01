const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { auth, requireVerified } = require('../middleware/auth');

const router = express.Router();

// Validation pour la mise à jour du profil
const updateProfileValidation = [
  body('firstName')
    .optional()
    .trim()
    .isLength({ min: 2 })
    .withMessage('Le prénom doit contenir au moins 2 caractères'),
  body('lastName')
    .optional()
    .trim()
    .isLength({ min: 2 })
    .withMessage('Le nom doit contenir au moins 2 caractères'),
  body('phone')
    .optional()
    .isMobilePhone()
    .withMessage('Numéro de téléphone invalide'),
  body('userType')
    .optional()
    .isIn(['traveler', 'sender', 'both'])
    .withMessage('Type d\'utilisateur invalide')
];

// Validation pour le changement de mot de passe
const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Le mot de passe actuel est requis'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('Le nouveau mot de passe doit contenir au moins 6 caractères')
];

// Obtenir le profil de l'utilisateur connecté
router.get('/profile', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, first_name, last_name, phone, profile_picture, 
              user_type, is_verified, rating, total_ratings, created_at
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        profilePicture: user.profile_picture,
        userType: user.user_type,
        isVerified: user.is_verified,
        rating: parseFloat(user.rating),
        totalRatings: user.total_ratings,
        createdAt: user.created_at
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir le profil public d'un utilisateur
router.get('/:userId/profile', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await db.query(
      `SELECT id, first_name, last_name, profile_picture, user_type, 
              rating, total_ratings, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        profilePicture: user.profile_picture,
        userType: user.user_type,
        rating: parseFloat(user.rating),
        totalRatings: user.total_ratings,
        memberSince: user.created_at
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération du profil public:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Mettre à jour le profil
router.put('/profile', auth, updateProfileValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }

    const { firstName, lastName, phone, userType, profilePicture } = req.body;
    const userId = req.user.userId;

    // Construire la requête de mise à jour dynamiquement
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (firstName !== undefined) {
      updates.push(`first_name = $${paramCount}`);
      values.push(firstName);
      paramCount++;
    }

    if (lastName !== undefined) {
      updates.push(`last_name = $${paramCount}`);
      values.push(lastName);
      paramCount++;
    }

    if (phone !== undefined) {
      updates.push(`phone = $${paramCount}`);
      values.push(phone);
      paramCount++;
    }

    if (userType !== undefined) {
      updates.push(`user_type = $${paramCount}`);
      values.push(userType);
      paramCount++;
    }

    if (profilePicture !== undefined) {
      updates.push(`profile_picture = $${paramCount}`);
      values.push(profilePicture);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'Aucune donnée à mettre à jour'
      });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, email, first_name, last_name, phone, profile_picture, user_type, is_verified, rating
    `;

    const result = await db.query(query, values);
    const user = result.rows[0];

    res.json({
      message: 'Profil mis à jour avec succès',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        profilePicture: user.profile_picture,
        userType: user.user_type,
        isVerified: user.is_verified,
        rating: parseFloat(user.rating)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du profil:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Changer le mot de passe
router.put('/password', auth, changePasswordValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }

    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    // Vérifier le mot de passe actuel
    const userResult = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword, 
      userResult.rows[0].password_hash
    );

    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        error: 'Mot de passe actuel incorrect'
      });
    }

    // Hacher le nouveau mot de passe
    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Mettre à jour le mot de passe
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPasswordHash, userId]
    );

    res.json({
      message: 'Mot de passe modifié avec succès'
    });

  } catch (error) {
    console.error('Erreur lors du changement de mot de passe:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir les statistiques de l'utilisateur
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Statistiques des voyages (pour les voyageurs)
    const tripsStats = await db.query(
      `SELECT 
         COUNT(*) as total_trips,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_trips,
         COUNT(CASE WHEN status = 'active' THEN 1 END) as active_trips
       FROM trips WHERE traveler_id = $1`,
      [userId]
    );

    // Statistiques des colis (pour les expéditeurs)
    const packagesStats = await db.query(
      `SELECT 
         COUNT(*) as total_packages,
         COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_packages,
         COUNT(CASE WHEN status IN ('pending', 'accepted', 'in_transit') THEN 1 END) as active_packages
       FROM packages WHERE sender_id = $1`,
      [userId]
    );

    // Évaluations reçues
    const ratingsStats = await db.query(
      `SELECT 
         COUNT(*) as total_ratings,
         AVG(rating) as average_rating
       FROM ratings WHERE rated_id = $1`,
      [userId]
    );

    res.json({
      stats: {
        trips: tripsStats.rows[0],
        packages: packagesStats.rows[0],
        ratings: {
          total: parseInt(ratingsStats.rows[0].total_ratings),
          average: parseFloat(ratingsStats.rows[0].average_rating) || 0
        }
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

module.exports = router;