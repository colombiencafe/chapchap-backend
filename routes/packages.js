const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireUserType } = require('../middleware/auth');
const { searchPendingPackages, calculateCompatibility } = require('../services/searchService');

const router = express.Router();

// Validation pour créer un colis
const createPackageValidation = [
  body('tripId')
    .isInt({ min: 1 })
    .withMessage('ID de voyage invalide'),
  body('title')
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage('Le titre doit contenir entre 3 et 200 caractères'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('La description ne peut pas dépasser 1000 caractères'),
  body('weight')
    .isFloat({ min: 0.1, max: 50 })
    .withMessage('Le poids doit être entre 0.1 et 50 kg'),
  body('dimensions')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Les dimensions ne peuvent pas dépasser 100 caractères'),
  body('value')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('La valeur doit être positive'),
  body('pickupAddress')
    .trim()
    .isLength({ min: 10 })
    .withMessage('L\'adresse de collecte doit contenir au moins 10 caractères'),
  body('deliveryAddress')
    .trim()
    .isLength({ min: 10 })
    .withMessage('L\'adresse de livraison doit contenir au moins 10 caractères')
];

// Validation pour la recherche de colis
const searchPackagesValidation = [
  query('status').optional().isIn(['pending', 'accepted', 'in_transit', 'delivered', 'cancelled']),
  query('page').optional().isInt({ min: 1 }).withMessage('Numéro de page invalide'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limite invalide')
];

// Créer une demande de transport de colis
router.post('/', auth, requireUserType(['sender', 'both']), createPackageValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }

    const {
      tripId,
      title,
      description,
      weight,
      dimensions,
      value,
      pickupAddress,
      deliveryAddress
    } = req.body;

    const senderId = req.user.userId;

    // Vérifier que le voyage existe et est actif
    const tripResult = await db.query(
      `SELECT id, traveler_id, available_weight, price_per_kg, departure_date, status
       FROM trips WHERE id = $1`,
      [tripId]
    );

    if (tripResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Voyage non trouvé'
      });
    }

    const trip = tripResult.rows[0];

    if (trip.status !== 'active') {
      return res.status(400).json({
        error: 'Ce voyage n\'est plus disponible'
      });
    }

    // Vérifier que la date de départ n'est pas passée
    const today = new Date();
    const departureDate = new Date(trip.departure_date);
    if (departureDate <= today) {
      return res.status(400).json({
        error: 'La date de départ de ce voyage est déjà passée'
      });
    }

    // Vérifier que l'utilisateur ne demande pas le transport sur son propre voyage
    if (trip.traveler_id === senderId) {
      return res.status(400).json({
        error: 'Vous ne pouvez pas demander le transport sur votre propre voyage'
      });
    }

    // Vérifier que le poids est disponible
    if (weight > trip.available_weight) {
      return res.status(400).json({
        error: `Poids insuffisant disponible. Maximum: ${trip.available_weight} kg`
      });
    }

    // Calculer le prix total
    const totalPrice = weight * trip.price_per_kg;

    const result = await db.query(
      `INSERT INTO packages (
         sender_id, trip_id, title, description, weight, dimensions, 
         value, pickup_address, delivery_address, total_price
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        senderId, tripId, title, description, weight, dimensions,
        value, pickupAddress, deliveryAddress, totalPrice
      ]
    );

    const packageData = result.rows[0];

    res.status(201).json({
      message: 'Demande de transport créée avec succès',
      package: {
        id: packageData.id,
        senderId: packageData.sender_id,
        tripId: packageData.trip_id,
        title: packageData.title,
        description: packageData.description,
        weight: parseFloat(packageData.weight),
        dimensions: packageData.dimensions,
        value: packageData.value ? parseFloat(packageData.value) : null,
        pickupAddress: packageData.pickup_address,
        deliveryAddress: packageData.delivery_address,
        totalPrice: parseFloat(packageData.total_price),
        status: packageData.status,
        createdAt: packageData.created_at
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du colis:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir les colis de l'utilisateur connecté (en tant qu'expéditeur)
router.get('/my-packages', auth, requireUserType(['sender', 'both']), searchPackagesValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Paramètres invalides',
        details: errors.array()
      });
    }

    const { status, page = 1, limit = 10 } = req.query;
    const senderId = req.user.userId;

    let whereCondition = 'p.sender_id = $1';
    let queryParams = [senderId];
    let paramCount = 2;

    if (status) {
      whereCondition += ` AND p.status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    const result = await db.query(
      `SELECT 
         p.*,
         t.departure_country,
         t.departure_city,
         t.destination_country,
         t.destination_city,
         t.departure_date,
         t.arrival_date,
         u.first_name as traveler_first_name,
         u.last_name as traveler_last_name,
         u.profile_picture as traveler_profile_picture,
         u.rating as traveler_rating
       FROM packages p
       JOIN trips t ON p.trip_id = t.id
       JOIN users u ON t.traveler_id = u.id
       WHERE ${whereCondition}
       ORDER BY p.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      queryParams
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM packages p WHERE ${whereCondition}`,
      queryParams.slice(0, -2)
    );

    const total = parseInt(countResult.rows[0].total);

    const packages = result.rows.map(pkg => ({
      id: pkg.id,
      title: pkg.title,
      description: pkg.description,
      weight: parseFloat(pkg.weight),
      dimensions: pkg.dimensions,
      value: pkg.value ? parseFloat(pkg.value) : null,
      pickupAddress: pkg.pickup_address,
      deliveryAddress: pkg.delivery_address,
      totalPrice: parseFloat(pkg.total_price),
      status: pkg.status,
      createdAt: pkg.created_at,
      updatedAt: pkg.updated_at,
      trip: {
        id: pkg.trip_id,
        departureCountry: pkg.departure_country,
        departureCity: pkg.departure_city,
        destinationCountry: pkg.destination_country,
        destinationCity: pkg.destination_city,
        departureDate: pkg.departure_date,
        arrivalDate: pkg.arrival_date
      },
      traveler: {
        firstName: pkg.traveler_first_name,
        lastName: pkg.traveler_last_name,
        profilePicture: pkg.traveler_profile_picture,
        rating: parseFloat(pkg.traveler_rating)
      }
    }));

    res.json({
      packages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des colis:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir les demandes de transport pour les voyages de l'utilisateur (en tant que voyageur)
router.get('/trip-requests', auth, requireUserType(['traveler', 'both']), searchPackagesValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Paramètres invalides',
        details: errors.array()
      });
    }

    const { status, page = 1, limit = 10 } = req.query;
    const travelerId = req.user.userId;

    let whereCondition = 't.traveler_id = $1';
    let queryParams = [travelerId];
    let paramCount = 2;

    if (status) {
      whereCondition += ` AND p.status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    const result = await db.query(
      `SELECT 
         p.*,
         t.departure_country,
         t.departure_city,
         t.destination_country,
         t.destination_city,
         t.departure_date,
         t.arrival_date,
         u.first_name as sender_first_name,
         u.last_name as sender_last_name,
         u.profile_picture as sender_profile_picture,
         u.rating as sender_rating
       FROM packages p
       JOIN trips t ON p.trip_id = t.id
       JOIN users u ON p.sender_id = u.id
       WHERE ${whereCondition}
       ORDER BY p.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      queryParams
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total 
       FROM packages p 
       JOIN trips t ON p.trip_id = t.id 
       WHERE ${whereCondition}`,
      queryParams.slice(0, -2)
    );

    const total = parseInt(countResult.rows[0].total);

    const packages = result.rows.map(pkg => ({
      id: pkg.id,
      title: pkg.title,
      description: pkg.description,
      weight: parseFloat(pkg.weight),
      dimensions: pkg.dimensions,
      value: pkg.value ? parseFloat(pkg.value) : null,
      pickupAddress: pkg.pickup_address,
      deliveryAddress: pkg.delivery_address,
      totalPrice: parseFloat(pkg.total_price),
      status: pkg.status,
      createdAt: pkg.created_at,
      updatedAt: pkg.updated_at,
      trip: {
        id: pkg.trip_id,
        departureCountry: pkg.departure_country,
        departureCity: pkg.departure_city,
        destinationCountry: pkg.destination_country,
        destinationCity: pkg.destination_city,
        departureDate: pkg.departure_date,
        arrivalDate: pkg.arrival_date
      },
      sender: {
        firstName: pkg.sender_first_name,
        lastName: pkg.sender_last_name,
        profilePicture: pkg.sender_profile_picture,
        rating: parseFloat(pkg.sender_rating)
      }
    }));

    res.json({
      packages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des demandes:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir un colis spécifique
router.get('/:packageId', auth, async (req, res) => {
  try {
    const { packageId } = req.params;
    const userId = req.user.userId;

    const result = await db.query(
      `SELECT 
         p.*,
         t.traveler_id,
         t.departure_country,
         t.departure_city,
         t.destination_country,
         t.destination_city,
         t.departure_date,
         t.arrival_date,
         sender.first_name as sender_first_name,
         sender.last_name as sender_last_name,
         sender.profile_picture as sender_profile_picture,
         sender.rating as sender_rating,
         traveler.first_name as traveler_first_name,
         traveler.last_name as traveler_last_name,
         traveler.profile_picture as traveler_profile_picture,
         traveler.rating as traveler_rating
       FROM packages p
       JOIN trips t ON p.trip_id = t.id
       JOIN users sender ON p.sender_id = sender.id
       JOIN users traveler ON t.traveler_id = traveler.id
       WHERE p.id = $1`,
      [packageId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Colis non trouvé'
      });
    }

    const pkg = result.rows[0];

    // Vérifier que l'utilisateur a accès à ce colis
    if (pkg.sender_id !== userId && pkg.traveler_id !== userId) {
      return res.status(403).json({
        error: 'Accès non autorisé à ce colis'
      });
    }

    res.json({
      package: {
        id: pkg.id,
        title: pkg.title,
        description: pkg.description,
        weight: parseFloat(pkg.weight),
        dimensions: pkg.dimensions,
        value: pkg.value ? parseFloat(pkg.value) : null,
        pickupAddress: pkg.pickup_address,
        deliveryAddress: pkg.delivery_address,
        totalPrice: parseFloat(pkg.total_price),
        status: pkg.status,
        createdAt: pkg.created_at,
        updatedAt: pkg.updated_at,
        trip: {
          id: pkg.trip_id,
          departureCountry: pkg.departure_country,
          departureCity: pkg.departure_city,
          destinationCountry: pkg.destination_country,
          destinationCity: pkg.destination_city,
          departureDate: pkg.departure_date,
          arrivalDate: pkg.arrival_date
        },
        sender: {
          id: pkg.sender_id,
          firstName: pkg.sender_first_name,
          lastName: pkg.sender_last_name,
          profilePicture: pkg.sender_profile_picture,
          rating: parseFloat(pkg.sender_rating)
        },
        traveler: {
          id: pkg.traveler_id,
          firstName: pkg.traveler_first_name,
          lastName: pkg.traveler_last_name,
          profilePicture: pkg.traveler_profile_picture,
          rating: parseFloat(pkg.traveler_rating)
        }
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération du colis:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Accepter ou refuser une demande de transport (voyageur)
router.patch('/:packageId/status', auth, requireUserType(['traveler', 'both']), async (req, res) => {
  try {
    const { packageId } = req.params;
    const { status } = req.body;
    const travelerId = req.user.userId;

    if (!['accepted', 'cancelled'].includes(status)) {
      return res.status(400).json({
        error: 'Statut invalide. Utilisez "accepted" ou "cancelled"'
      });
    }

    // Vérifier que le colis existe et appartient à un voyage de l'utilisateur
    const packageResult = await db.query(
      `SELECT p.id, p.status, p.weight, t.traveler_id, t.available_weight
       FROM packages p
       JOIN trips t ON p.trip_id = t.id
       WHERE p.id = $1 AND t.traveler_id = $2`,
      [packageId, travelerId]
    );

    if (packageResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Colis non trouvé ou accès non autorisé'
      });
    }

    const packageData = packageResult.rows[0];

    if (packageData.status !== 'pending') {
      return res.status(400).json({
        error: 'Seules les demandes en attente peuvent être modifiées'
      });
    }

    // Si accepté, vérifier le poids disponible et le déduire
    if (status === 'accepted') {
      if (packageData.weight > packageData.available_weight) {
        return res.status(400).json({
          error: 'Poids insuffisant disponible'
        });
      }

      // Mettre à jour le colis et le poids disponible du voyage
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        await client.query(
          'UPDATE packages SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [status, packageId]
        );

        await client.query(
          'UPDATE trips SET available_weight = available_weight - $1, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT trip_id FROM packages WHERE id = $2)',
          [packageData.weight, packageId]
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      // Simplement mettre à jour le statut pour refus
      await db.query(
        'UPDATE packages SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [status, packageId]
      );
    }

    res.json({
      message: status === 'accepted' ? 'Demande acceptée avec succès' : 'Demande refusée',
      packageId: parseInt(packageId),
      newStatus: status
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Marquer un colis comme en transit (voyageur)
router.patch('/:packageId/in-transit', auth, requireUserType(['traveler', 'both']), async (req, res) => {
  try {
    const { packageId } = req.params;
    const travelerId = req.user.userId;

    const result = await db.query(
      `UPDATE packages 
       SET status = 'in_transit', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 
         AND status = 'accepted'
         AND trip_id IN (SELECT id FROM trips WHERE traveler_id = $2)
       RETURNING id, status`,
      [packageId, travelerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Colis non trouvé, accès non autorisé ou statut invalide'
      });
    }

    res.json({
      message: 'Colis marqué comme en transit',
      packageId: parseInt(packageId),
      newStatus: 'in_transit'
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Marquer un colis comme livré (voyageur)
router.patch('/:packageId/delivered', auth, requireUserType(['traveler', 'both']), async (req, res) => {
  try {
    const { packageId } = req.params;
    const travelerId = req.user.userId;

    const result = await db.query(
      `UPDATE packages 
       SET status = 'delivered', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 
         AND status = 'in_transit'
         AND trip_id IN (SELECT id FROM trips WHERE traveler_id = $2)
       RETURNING id, status`,
      [packageId, travelerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Colis non trouvé, accès non autorisé ou statut invalide'
      });
    }

    res.json({
      message: 'Colis marqué comme livré',
      packageId: parseInt(packageId),
      newStatus: 'delivered'
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Annuler un colis (expéditeur)
router.patch('/:packageId/cancel', auth, requireUserType(['sender', 'both']), async (req, res) => {
  try {
    const { packageId } = req.params;
    const senderId = req.user.userId;

    // Récupérer les informations du colis
    const packageResult = await db.query(
      `SELECT p.id, p.status, p.weight, p.trip_id
       FROM packages p
       WHERE p.id = $1 AND p.sender_id = $2`,
      [packageId, senderId]
    );

    if (packageResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Colis non trouvé ou accès non autorisé'
      });
    }

    const packageData = packageResult.rows[0];

    if (!['pending', 'accepted'].includes(packageData.status)) {
      return res.status(400).json({
        error: 'Seuls les colis en attente ou acceptés peuvent être annulés'
      });
    }

    // Si le colis était accepté, remettre le poids disponible
    if (packageData.status === 'accepted') {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        await client.query(
          'UPDATE packages SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['cancelled', packageId]
        );

        await client.query(
          'UPDATE trips SET available_weight = available_weight + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [packageData.weight, packageData.trip_id]
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      await db.query(
        'UPDATE packages SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        ['cancelled', packageId]
      );
    }

    res.json({
      message: 'Colis annulé avec succès',
      packageId: parseInt(packageId),
      newStatus: 'cancelled'
    });

  } catch (error) {
    console.error('Erreur lors de l\'annulation du colis:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Recherche avancée de colis pour voyageurs
router.get('/search', [
  query('departure_country').optional().isString().trim(),
  query('destination_country').optional().isString().trim(),
  query('max_weight').optional().isFloat({ min: 0 }),
  query('min_price').optional().isFloat({ min: 0 }),
  query('max_price').optional().isFloat({ min: 0 }),
  query('status').optional().isIn(['pending', 'accepted', 'in_transit', 'delivered', 'cancelled']),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const searchCriteria = {
      departureCountry: req.query.departure_country,
      destinationCountry: req.query.destination_country,
      maxWeight: req.query.max_weight ? parseFloat(req.query.max_weight) : null,
      minPrice: req.query.min_price ? parseFloat(req.query.min_price) : null,
      maxPrice: req.query.max_price ? parseFloat(req.query.max_price) : null,
      status: req.query.status || 'pending',
      page: req.query.page || 1,
      limit: req.query.limit || 10
    };

    const results = await searchPendingPackages(searchCriteria);
    res.json(results);

  } catch (error) {
    console.error('Erreur lors de la recherche de colis:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// Calculer la compatibilité entre un colis et un voyage
router.get('/:packageId/compatibility/:tripId', auth, async (req, res) => {
  try {
    const packageId = parseInt(req.params.packageId);
    const tripId = parseInt(req.params.tripId);
    const userId = req.user.userId;

    // Récupérer les informations du colis
    const packageQuery = `
      SELECT p.*, u.first_name, u.last_name
      FROM packages p
      JOIN users u ON p.sender_id = u.id
      WHERE p.id = $1
    `;
    const packageResult = await db.query(packageQuery, [packageId]);

    if (packageResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colis non trouvé' });
    }

    // Récupérer les informations du voyage
    const tripQuery = `
      SELECT t.*, u.first_name, u.last_name
      FROM trips t
      JOIN users u ON t.traveler_id = u.id
      WHERE t.id = $1
    `;
    const tripResult = await db.query(tripQuery, [tripId]);

    if (tripResult.rows.length === 0) {
      return res.status(404).json({ error: 'Voyage non trouvé' });
    }

    const packageData = packageResult.rows[0];
    const tripData = tripResult.rows[0];

    // Calculer la compatibilité
    const compatibility = calculateCompatibility(tripData, packageData);

    res.json({
      package: {
        id: packageData.id,
        title: packageData.title,
        description: packageData.description,
        weight: parseFloat(packageData.weight),
        value: parseFloat(packageData.value),
        totalPrice: parseFloat(packageData.total_price),
        pickupAddress: packageData.pickup_address,
        deliveryAddress: packageData.delivery_address,
        sender: {
          firstName: packageData.first_name,
          lastName: packageData.last_name
        }
      },
      trip: {
        id: tripData.id,
        route: {
          departure: {
            country: tripData.departure_country,
            city: tripData.departure_city
          },
          destination: {
            country: tripData.destination_country,
            city: tripData.destination_city
          }
        },
        schedule: {
          departureDate: tripData.departure_date,
          arrivalDate: tripData.arrival_date
        },
        capacity: {
          availableWeight: parseFloat(tripData.available_weight),
          pricePerKg: parseFloat(tripData.price_per_kg)
        },
        traveler: {
          firstName: tripData.first_name,
          lastName: tripData.last_name
        }
      },
      compatibility
    });

  } catch (error) {
    console.error('Erreur lors du calcul de compatibilité:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;