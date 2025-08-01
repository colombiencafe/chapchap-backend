const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireUserType } = require('../middleware/auth');
const { searchTripsForSenders, findMatchingPackagesForTrip } = require('../services/searchService');

const router = express.Router();

// Validation pour créer un voyage
const createTripValidation = [
  body('departureCountry')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Le pays de départ est requis'),
  body('departureCity')
    .trim()
    .isLength({ min: 2 })
    .withMessage('La ville de départ est requise'),
  body('destinationCountry')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Le pays de destination est requis'),
  body('destinationCity')
    .trim()
    .isLength({ min: 2 })
    .withMessage('La ville de destination est requise'),
  body('departureDate')
    .isISO8601()
    .withMessage('Date de départ invalide'),
  body('arrivalDate')
    .optional()
    .isISO8601()
    .withMessage('Date d\'arrivée invalide'),
  body('availableWeight')
    .isFloat({ min: 0.1, max: 50 })
    .withMessage('Le poids disponible doit être entre 0.1 et 50 kg'),
  body('pricePerKg')
    .isFloat({ min: 0.01 })
    .withMessage('Le prix par kg doit être supérieur à 0')
];

// Validation pour la recherche de voyages
const searchTripsValidation = [
  query('departureCountry').optional().trim(),
  query('destinationCountry').optional().trim(),
  query('departureDate').optional().isISO8601().withMessage('Date de départ invalide'),
  query('maxPricePerKg').optional().isFloat({ min: 0 }).withMessage('Prix maximum invalide'),
  query('minWeight').optional().isFloat({ min: 0 }).withMessage('Poids minimum invalide'),
  query('page').optional().isInt({ min: 1 }).withMessage('Numéro de page invalide'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limite invalide')
];

// Créer un nouveau voyage
router.post('/', auth, requireUserType(['traveler', 'both']), createTripValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }

    const {
      departureCountry,
      departureCity,
      destinationCountry,
      destinationCity,
      departureDate,
      arrivalDate,
      availableWeight,
      pricePerKg,
      description
    } = req.body;

    const travelerId = req.user.userId;

    // Vérifier que la date de départ est dans le futur
    const today = new Date();
    const depDate = new Date(departureDate);
    if (depDate <= today) {
      return res.status(400).json({
        error: 'La date de départ doit être dans le futur'
      });
    }

    // Vérifier que la date d'arrivée est après la date de départ
    if (arrivalDate) {
      const arrDate = new Date(arrivalDate);
      if (arrDate <= depDate) {
        return res.status(400).json({
          error: 'La date d\'arrivée doit être après la date de départ'
        });
      }
    }

    const result = await db.query(
      `INSERT INTO trips (
         traveler_id, departure_country, departure_city, destination_country, 
         destination_city, departure_date, arrival_date, available_weight, 
         price_per_kg, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        travelerId, departureCountry, departureCity, destinationCountry,
        destinationCity, departureDate, arrivalDate, availableWeight,
        pricePerKg, description
      ]
    );

    const trip = result.rows[0];

    res.status(201).json({
      message: 'Voyage créé avec succès',
      trip: {
        id: trip.id,
        travelerId: trip.traveler_id,
        departureCountry: trip.departure_country,
        departureCity: trip.departure_city,
        destinationCountry: trip.destination_country,
        destinationCity: trip.destination_city,
        departureDate: trip.departure_date,
        arrivalDate: trip.arrival_date,
        availableWeight: parseFloat(trip.available_weight),
        pricePerKg: parseFloat(trip.price_per_kg),
        description: trip.description,
        status: trip.status,
        createdAt: trip.created_at
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du voyage:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Recherche avancée de voyages pour expéditeurs
router.get('/search', [
  query('departure_country').optional().isString().trim(),
  query('departure_city').optional().isString().trim(),
  query('destination_country').optional().isString().trim(),
  query('destination_city').optional().isString().trim(),
  query('departure_date').optional().isISO8601(),
  query('arrival_date').optional().isISO8601(),
  query('min_weight').optional().isFloat({ min: 0 }),
  query('max_price_per_kg').optional().isFloat({ min: 0 }),
  query('proximity_radius').optional().isInt({ min: 1 }),
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
      departureCity: req.query.departure_city,
      destinationCountry: req.query.destination_country,
      destinationCity: req.query.destination_city,
      departureDate: req.query.departure_date,
      arrivalDate: req.query.arrival_date,
      minWeight: req.query.min_weight ? parseFloat(req.query.min_weight) : null,
      maxPricePerKg: req.query.max_price_per_kg ? parseFloat(req.query.max_price_per_kg) : null,
      proximityRadius: req.query.proximity_radius ? parseInt(req.query.proximity_radius) : null,
      page: req.query.page || 1,
      limit: req.query.limit || 10
    };

    const results = await searchTripsForSenders(searchCriteria);
    res.json(results);

  } catch (error) {
    console.error('Erreur lors de la recherche de voyages:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// Obtenir les voyages de l'utilisateur connecté
router.get('/my-trips', auth, requireUserType(['traveler', 'both']), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const travelerId = req.user.userId;

    let whereCondition = 'traveler_id = $1';
    let queryParams = [travelerId];
    let paramCount = 2;

    if (status && ['active', 'completed', 'cancelled'].includes(status)) {
      whereCondition += ` AND status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    const result = await db.query(
      `SELECT * FROM trips 
       WHERE ${whereCondition}
       ORDER BY departure_date DESC, created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      queryParams
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM trips WHERE ${whereCondition}`,
      queryParams.slice(0, -2)
    );

    const total = parseInt(countResult.rows[0].total);

    const trips = result.rows.map(trip => ({
      id: trip.id,
      departureCountry: trip.departure_country,
      departureCity: trip.departure_city,
      destinationCountry: trip.destination_country,
      destinationCity: trip.destination_city,
      departureDate: trip.departure_date,
      arrivalDate: trip.arrival_date,
      availableWeight: parseFloat(trip.available_weight),
      pricePerKg: parseFloat(trip.price_per_kg),
      description: trip.description,
      status: trip.status,
      createdAt: trip.created_at,
      updatedAt: trip.updated_at
    }));

    res.json({
      trips,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des voyages:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir un voyage spécifique
router.get('/:tripId', async (req, res) => {
  try {
    const { tripId } = req.params;

    const result = await db.query(
      `SELECT 
         t.*,
         u.first_name,
         u.last_name,
         u.profile_picture,
         u.rating,
         u.total_ratings,
         u.created_at as member_since
       FROM trips t
       JOIN users u ON t.traveler_id = u.id
       WHERE t.id = $1`,
      [tripId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Voyage non trouvé'
      });
    }

    const trip = result.rows[0];

    res.json({
      trip: {
        id: trip.id,
        traveler: {
          id: trip.traveler_id,
          firstName: trip.first_name,
          lastName: trip.last_name,
          profilePicture: trip.profile_picture,
          rating: parseFloat(trip.rating),
          totalRatings: trip.total_ratings,
          memberSince: trip.member_since
        },
        departureCountry: trip.departure_country,
        departureCity: trip.departure_city,
        destinationCountry: trip.destination_country,
        destinationCity: trip.destination_city,
        departureDate: trip.departure_date,
        arrivalDate: trip.arrival_date,
        availableWeight: parseFloat(trip.available_weight),
        pricePerKg: parseFloat(trip.price_per_kg),
        description: trip.description,
        status: trip.status,
        createdAt: trip.created_at
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération du voyage:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Mettre à jour un voyage
router.put('/:tripId', auth, requireUserType(['traveler', 'both']), async (req, res) => {
  try {
    const { tripId } = req.params;
    const travelerId = req.user.userId;

    // Vérifier que le voyage appartient à l'utilisateur
    const tripCheck = await db.query(
      'SELECT id, status FROM trips WHERE id = $1 AND traveler_id = $2',
      [tripId, travelerId]
    );

    if (tripCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Voyage non trouvé ou accès non autorisé'
      });
    }

    if (tripCheck.rows[0].status !== 'active') {
      return res.status(400).json({
        error: 'Seuls les voyages actifs peuvent être modifiés'
      });
    }

    const {
      departureCountry,
      departureCity,
      destinationCountry,
      destinationCity,
      departureDate,
      arrivalDate,
      availableWeight,
      pricePerKg,
      description,
      status
    } = req.body;

    // Construire la requête de mise à jour
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (departureCountry !== undefined) {
      updates.push(`departure_country = $${paramCount}`);
      values.push(departureCountry);
      paramCount++;
    }

    if (departureCity !== undefined) {
      updates.push(`departure_city = $${paramCount}`);
      values.push(departureCity);
      paramCount++;
    }

    if (destinationCountry !== undefined) {
      updates.push(`destination_country = $${paramCount}`);
      values.push(destinationCountry);
      paramCount++;
    }

    if (destinationCity !== undefined) {
      updates.push(`destination_city = $${paramCount}`);
      values.push(destinationCity);
      paramCount++;
    }

    if (departureDate !== undefined) {
      updates.push(`departure_date = $${paramCount}`);
      values.push(departureDate);
      paramCount++;
    }

    if (arrivalDate !== undefined) {
      updates.push(`arrival_date = $${paramCount}`);
      values.push(arrivalDate);
      paramCount++;
    }

    if (availableWeight !== undefined) {
      updates.push(`available_weight = $${paramCount}`);
      values.push(availableWeight);
      paramCount++;
    }

    if (pricePerKg !== undefined) {
      updates.push(`price_per_kg = $${paramCount}`);
      values.push(pricePerKg);
      paramCount++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(description);
      paramCount++;
    }

    if (status !== undefined && ['active', 'cancelled'].includes(status)) {
      updates.push(`status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'Aucune donnée à mettre à jour'
      });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(tripId);

    const updateQuery = `
      UPDATE trips 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await db.query(updateQuery, values);
    const trip = result.rows[0];

    res.json({
      message: 'Voyage mis à jour avec succès',
      trip: {
        id: trip.id,
        departureCountry: trip.departure_country,
        departureCity: trip.departure_city,
        destinationCountry: trip.destination_country,
        destinationCity: trip.destination_city,
        departureDate: trip.departure_date,
        arrivalDate: trip.arrival_date,
        availableWeight: parseFloat(trip.available_weight),
        pricePerKg: parseFloat(trip.price_per_kg),
        description: trip.description,
        status: trip.status,
        updatedAt: trip.updated_at
      }
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du voyage:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Supprimer un voyage
router.delete('/:tripId', auth, requireUserType(['traveler', 'both']), async (req, res) => {
  try {
    const { tripId } = req.params;
    const travelerId = req.user.userId;

    // Vérifier que le voyage appartient à l'utilisateur et qu'il peut être supprimé
    const tripCheck = await db.query(
      'SELECT id, status FROM trips WHERE id = $1 AND traveler_id = $2',
      [tripId, travelerId]
    );

    if (tripCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Voyage non trouvé ou accès non autorisé'
      });
    }

    // Vérifier qu'il n'y a pas de colis associés
    const packagesCheck = await db.query(
      'SELECT COUNT(*) as count FROM packages WHERE trip_id = $1 AND status NOT IN ($2, $3)',
      [tripId, 'cancelled', 'delivered']
    );

    if (parseInt(packagesCheck.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'Impossible de supprimer un voyage avec des colis en cours'
      });
    }

    await db.query('DELETE FROM trips WHERE id = $1', [tripId]);

    res.json({
      message: 'Voyage supprimé avec succès'
    });

  } catch (error) {
    console.error('Erreur lors de la recherche de voyages:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// Obtenir les colis compatibles avec un voyage (pour les voyageurs)
router.get('/:id/matching-packages', auth, async (req, res) => {
  try {
    const tripId = parseInt(req.params.id);
    const userId = req.user.userId;

    // Vérifier que le voyage existe et appartient à l'utilisateur
    const tripQuery = 'SELECT * FROM trips WHERE id = $1 AND traveler_id = $2';
    const tripResult = await db.query(tripQuery, [tripId, userId]);

    if (tripResult.rows.length === 0) {
      return res.status(404).json({ error: 'Voyage non trouvé ou non autorisé' });
    }

    const trip = tripResult.rows[0];
    
    // Vérifier que le voyage est actif
    if (trip.status !== 'active') {
      return res.status(400).json({ error: 'Le voyage doit être actif pour voir les colis compatibles' });
    }

    const matchingPackages = await findMatchingPackagesForTrip(tripId, userId);

    res.json({
      trip: {
        id: trip.id,
        route: {
          departure: {
            country: trip.departure_country,
            city: trip.departure_city
          },
          destination: {
            country: trip.destination_country,
            city: trip.destination_city
          }
        },
        schedule: {
          departureDate: trip.departure_date,
          arrivalDate: trip.arrival_date
        },
        capacity: {
          availableWeight: parseFloat(trip.available_weight),
          pricePerKg: parseFloat(trip.price_per_kg)
        }
      },
      matchingPackages,
      totalMatches: matchingPackages.length
    });

  } catch (error) {
    console.error('Erreur lors de la recherche de colis compatibles:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;