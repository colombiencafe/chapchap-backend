const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { 
  searchTripsForSenders, 
  findMatchingPackagesForTrip, 
  searchPendingPackages, 
  calculateCompatibility 
} = require('../services/searchService');

const router = express.Router();

/**
 * Routes de matching et de recherche avancée pour ChapChap
 * Centralise toutes les fonctionnalités de recherche et de compatibilité
 */

// Recherche intelligente de voyages pour expéditeurs avec recommandations
router.get('/trips/smart-search', [
  query('departure_country').optional().isString().trim(),
  query('departure_city').optional().isString().trim(),
  query('destination_country').optional().isString().trim(),
  query('destination_city').optional().isString().trim(),
  query('departure_date').optional().isISO8601(),
  query('arrival_date').optional().isISO8601(),
  query('package_weight').isFloat({ min: 0.1 }).withMessage('Le poids du colis est requis'),
  query('max_price_per_kg').optional().isFloat({ min: 0 }),
  query('proximity_radius').optional().isInt({ min: 1 }),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt()
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const packageWeight = parseFloat(req.query.package_weight);
    
    const searchCriteria = {
      departureCountry: req.query.departure_country,
      departureCity: req.query.departure_city,
      destinationCountry: req.query.destination_country,
      destinationCity: req.query.destination_city,
      departureDate: req.query.departure_date,
      arrivalDate: req.query.arrival_date,
      minWeight: packageWeight, // Le voyage doit pouvoir porter au moins le poids du colis
      maxPricePerKg: req.query.max_price_per_kg ? parseFloat(req.query.max_price_per_kg) : null,
      proximityRadius: req.query.proximity_radius ? parseInt(req.query.proximity_radius) : null,
      page: req.query.page || 1,
      limit: req.query.limit || 10
    };

    const results = await searchTripsForSenders(searchCriteria);
    
    // Ajouter des recommandations personnalisées
    const enhancedTrips = results.trips.map(trip => {
      const estimatedCost = packageWeight * trip.capacity.pricePerKg;
      const weightUtilization = (packageWeight / trip.capacity.availableWeight) * 100;
      
      return {
        ...trip,
        recommendation: {
          estimatedCost: parseFloat(estimatedCost.toFixed(2)),
          weightUtilization: parseFloat(weightUtilization.toFixed(1)),
          isOptimal: weightUtilization >= 30 && weightUtilization <= 80,
          reasons: [
            ...(trip.traveler.isVerified ? ['Voyageur vérifié'] : []),
            ...(trip.traveler.rating >= 4.5 ? ['Excellente réputation'] : []),
            ...(weightUtilization >= 50 ? ['Utilisation optimale de l\'espace'] : []),
            ...(trip.compatibilityScore >= 15 ? ['Très compatible avec votre demande'] : [])
          ]
        }
      };
    });

    res.json({
      ...results,
      trips: enhancedTrips,
      searchContext: {
        packageWeight,
        totalResults: results.pagination.total,
        averagePrice: enhancedTrips.length > 0 
          ? enhancedTrips.reduce((sum, trip) => sum + trip.recommendation.estimatedCost, 0) / enhancedTrips.length
          : 0
      }
    });

  } catch (error) {
    console.error('Erreur lors de la recherche intelligente de voyages:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// Tableau de bord de matching pour voyageurs
router.get('/packages/dashboard/:tripId', auth, async (req, res) => {
  try {
    const tripId = parseInt(req.params.tripId);
    const userId = req.user.userId;

    // Vérifier que le voyage appartient à l'utilisateur
    const tripQuery = 'SELECT * FROM trips WHERE id = $1 AND traveler_id = $2';
    const tripResult = await db.query(tripQuery, [tripId, userId]);

    if (tripResult.rows.length === 0) {
      return res.status(404).json({ error: 'Voyage non trouvé ou non autorisé' });
    }

    const trip = tripResult.rows[0];
    
    // Obtenir les colis compatibles
    const matchingPackages = await findMatchingPackagesForTrip(tripId, userId);
    
    // Calculer les statistiques
    const totalPotentialRevenue = matchingPackages.reduce((sum, pkg) => sum + pkg.package.totalPrice, 0);
    const totalWeight = matchingPackages.reduce((sum, pkg) => sum + pkg.package.weight, 0);
    const averageCompatibility = matchingPackages.length > 0 
      ? matchingPackages.reduce((sum, pkg) => sum + pkg.compatibilityScore, 0) / matchingPackages.length
      : 0;

    // Grouper par niveau de compatibilité
    const packagesByCompatibility = {
      excellent: matchingPackages.filter(pkg => pkg.compatibilityScore >= 25),
      good: matchingPackages.filter(pkg => pkg.compatibilityScore >= 15 && pkg.compatibilityScore < 25),
      fair: matchingPackages.filter(pkg => pkg.compatibilityScore >= 10 && pkg.compatibilityScore < 15),
      poor: matchingPackages.filter(pkg => pkg.compatibilityScore < 10)
    };

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
        },
        status: trip.status
      },
      statistics: {
        totalMatches: matchingPackages.length,
        totalPotentialRevenue: parseFloat(totalPotentialRevenue.toFixed(2)),
        totalWeight: parseFloat(totalWeight.toFixed(2)),
        averageCompatibility: parseFloat(averageCompatibility.toFixed(1)),
        capacityUtilization: parseFloat(((totalWeight / trip.available_weight) * 100).toFixed(1))
      },
      packagesByCompatibility,
      recommendations: {
        bestMatches: packagesByCompatibility.excellent.slice(0, 3),
        quickWins: matchingPackages
          .filter(pkg => pkg.package.weight <= trip.available_weight * 0.3)
          .sort((a, b) => b.package.totalPrice - a.package.totalPrice)
          .slice(0, 5),
        highValue: matchingPackages
          .filter(pkg => pkg.package.totalPrice >= 50)
          .sort((a, b) => b.package.totalPrice - a.package.totalPrice)
          .slice(0, 3)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération du tableau de bord:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// Analyse de compatibilité détaillée
router.get('/compatibility/analyze', [
  query('package_id').isInt({ min: 1 }).withMessage('ID du colis requis'),
  query('trip_id').isInt({ min: 1 }).withMessage('ID du voyage requis')
], auth, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const packageId = parseInt(req.query.package_id);
    const tripId = parseInt(req.query.trip_id);

    // Récupérer les données complètes
    const packageQuery = `
      SELECT p.*, u.first_name as sender_first_name, u.last_name as sender_last_name, 
             u.rating as sender_rating, u.is_verified as sender_verified
      FROM packages p
      JOIN users u ON p.sender_id = u.id
      WHERE p.id = $1
    `;
    const packageResult = await db.query(packageQuery, [packageId]);

    const tripQuery = `
      SELECT t.*, u.first_name as traveler_first_name, u.last_name as traveler_last_name,
             u.rating as traveler_rating, u.is_verified as traveler_verified
      FROM trips t
      JOIN users u ON t.traveler_id = u.id
      WHERE t.id = $1
    `;
    const tripResult = await db.query(tripQuery, [tripId]);

    if (packageResult.rows.length === 0 || tripResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colis ou voyage non trouvé' });
    }

    const packageData = packageResult.rows[0];
    const tripData = tripResult.rows[0];

    // Calculer la compatibilité détaillée
    const compatibility = calculateCompatibility(tripData, packageData);
    
    // Ajouter des analyses supplémentaires
    const analysis = {
      geographic: {
        departureMatch: packageData.pickup_address.toLowerCase().includes(tripData.departure_country.toLowerCase()) ||
                       packageData.pickup_address.toLowerCase().includes(tripData.departure_city.toLowerCase()),
        destinationMatch: packageData.delivery_address.toLowerCase().includes(tripData.destination_country.toLowerCase()) ||
                         packageData.delivery_address.toLowerCase().includes(tripData.destination_city.toLowerCase()),
        score: compatibility.details.geographic ? 'Excellent' : 'Incompatible'
      },
      logistics: {
        weightCompatibility: packageData.weight <= tripData.available_weight,
        weightUtilization: (packageData.weight / tripData.available_weight) * 100,
        priceAlignment: packageData.total_price >= (packageData.weight * tripData.price_per_kg * 0.9),
        estimatedEarnings: packageData.weight * tripData.price_per_kg
      },
      trust: {
        senderRating: parseFloat(packageData.sender_rating),
        travelerRating: parseFloat(tripData.traveler_rating),
        bothVerified: packageData.sender_verified && tripData.traveler_verified,
        riskLevel: packageData.sender_rating >= 4.0 && tripData.traveler_rating >= 4.0 ? 'Low' : 'Medium'
      },
      timeline: {
        departureDate: tripData.departure_date,
        packageCreated: packageData.created_at,
        urgency: Math.abs(new Date(tripData.departure_date) - new Date()) / (1000 * 60 * 60 * 24) <= 7 ? 'High' : 'Normal'
      }
    };

    res.json({
      package: {
        id: packageData.id,
        title: packageData.title,
        weight: parseFloat(packageData.weight),
        value: parseFloat(packageData.value),
        totalPrice: parseFloat(packageData.total_price),
        addresses: {
          pickup: packageData.pickup_address,
          delivery: packageData.delivery_address
        },
        sender: {
          name: `${packageData.sender_first_name} ${packageData.sender_last_name}`,
          rating: parseFloat(packageData.sender_rating),
          verified: packageData.sender_verified
        }
      },
      trip: {
        id: tripData.id,
        route: {
          departure: `${tripData.departure_city}, ${tripData.departure_country}`,
          destination: `${tripData.destination_city}, ${tripData.destination_country}`
        },
        capacity: {
          available: parseFloat(tripData.available_weight),
          pricePerKg: parseFloat(tripData.price_per_kg)
        },
        traveler: {
          name: `${tripData.traveler_first_name} ${tripData.traveler_last_name}`,
          rating: parseFloat(tripData.traveler_rating),
          verified: tripData.traveler_verified
        }
      },
      compatibility,
      analysis,
      recommendation: {
        shouldAccept: compatibility.score >= 50 && analysis.trust.riskLevel === 'Low',
        concerns: [
          ...(analysis.logistics.weightUtilization > 90 ? ['Utilisation maximale de la capacité'] : []),
          ...(analysis.trust.riskLevel === 'Medium' ? ['Vérifier les profils utilisateur'] : []),
          ...(!analysis.geographic.departureMatch ? ['Vérifier la compatibilité géographique de départ'] : []),
          ...(!analysis.geographic.destinationMatch ? ['Vérifier la compatibilité géographique de destination'] : [])
        ],
        benefits: [
          ...(analysis.logistics.estimatedEarnings >= 30 ? ['Revenus attractifs'] : []),
          ...(analysis.trust.bothVerified ? ['Utilisateurs vérifiés'] : []),
          ...(analysis.logistics.weightUtilization >= 30 && analysis.logistics.weightUtilization <= 70 ? ['Utilisation optimale de l\'espace'] : [])
        ]
      }
    });

  } catch (error) {
    console.error('Erreur lors de l\'analyse de compatibilité:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

// Suggestions de prix pour un trajet
router.get('/pricing/suggestions', [
  query('departure_country').isString().trim().withMessage('Pays de départ requis'),
  query('destination_country').isString().trim().withMessage('Pays de destination requis'),
  query('weight').isFloat({ min: 0.1 }).withMessage('Poids requis')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { departure_country, destination_country, weight } = req.query;
    const packageWeight = parseFloat(weight);

    // Analyser les prix du marché pour des trajets similaires
    const marketAnalysisQuery = `
      SELECT 
        AVG(t.price_per_kg) as avg_price,
        MIN(t.price_per_kg) as min_price,
        MAX(t.price_per_kg) as max_price,
        COUNT(*) as total_trips
      FROM trips t
      WHERE t.departure_country ILIKE $1
      AND t.destination_country ILIKE $2
      AND t.status = 'active'
      AND t.departure_date >= CURRENT_DATE
    `;
    
    const marketResult = await db.query(marketAnalysisQuery, [`%${departure_country}%`, `%${destination_country}%`]);
    const marketData = marketResult.rows[0];

    if (parseInt(marketData.total_trips) === 0) {
      return res.json({
        suggestions: {
          recommended: null,
          competitive: null,
          premium: null
        },
        marketData: {
          available: false,
          message: 'Pas assez de données pour ce trajet'
        },
        estimatedCost: {
          low: packageWeight * 5,
          medium: packageWeight * 10,
          high: packageWeight * 15
        }
      });
    }

    const avgPrice = parseFloat(marketData.avg_price);
    const minPrice = parseFloat(marketData.min_price);
    const maxPrice = parseFloat(marketData.max_price);

    res.json({
      suggestions: {
        competitive: {
          pricePerKg: parseFloat((avgPrice * 0.9).toFixed(2)),
          totalCost: parseFloat((packageWeight * avgPrice * 0.9).toFixed(2)),
          description: 'Prix compétitif pour attirer rapidement'
        },
        recommended: {
          pricePerKg: parseFloat(avgPrice.toFixed(2)),
          totalCost: parseFloat((packageWeight * avgPrice).toFixed(2)),
          description: 'Prix moyen du marché'
        },
        premium: {
          pricePerKg: parseFloat((avgPrice * 1.2).toFixed(2)),
          totalCost: parseFloat((packageWeight * avgPrice * 1.2).toFixed(2)),
          description: 'Prix premium pour service de qualité'
        }
      },
      marketData: {
        available: true,
        averagePrice: parseFloat(avgPrice.toFixed(2)),
        priceRange: {
          min: parseFloat(minPrice.toFixed(2)),
          max: parseFloat(maxPrice.toFixed(2))
        },
        totalTrips: parseInt(marketData.total_trips)
      },
      route: {
        departure: departure_country,
        destination: destination_country,
        weight: packageWeight
      }
    });

  } catch (error) {
    console.error('Erreur lors de l\'analyse de prix:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;