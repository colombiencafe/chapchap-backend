const db = require('../config/database');

/**
 * Service de recherche et de matching pour ChapChap
 * Gère la recherche de voyages pour les expéditeurs et le matching de colis pour les voyageurs
 */

/**
 * Recherche avancée de voyages pour les expéditeurs
 * @param {Object} criteria - Critères de recherche
 * @param {string} criteria.departureCountry - Pays de départ
 * @param {string} criteria.departureCity - Ville de départ
 * @param {string} criteria.destinationCountry - Pays de destination
 * @param {string} criteria.destinationCity - Ville de destination
 * @param {string} criteria.departureDate - Date de départ (YYYY-MM-DD)
 * @param {string} criteria.arrivalDate - Date d'arrivée (YYYY-MM-DD)
 * @param {number} criteria.minWeight - Poids minimum disponible
 * @param {number} criteria.maxPricePerKg - Prix maximum par kg
 * @param {number} criteria.proximityRadius - Rayon de proximité en km (optionnel)
 * @param {number} criteria.page - Page de résultats
 * @param {number} criteria.limit - Limite de résultats par page
 * @returns {Object} Résultats de recherche avec pagination
 */
const searchTripsForSenders = async (criteria) => {
  try {
    const {
      departureCountry,
      departureCity,
      destinationCountry,
      destinationCity,
      departureDate,
      arrivalDate,
      minWeight,
      maxPricePerKg,
      proximityRadius,
      page = 1,
      limit = 10
    } = criteria;

    // Construction dynamique de la requête
    let whereConditions = [
      't.status = $1',
      't.departure_date >= CURRENT_DATE',
      't.available_weight > 0'
    ];
    let queryParams = ['active'];
    let paramCount = 2;

    // Filtres géographiques
    if (departureCountry) {
      whereConditions.push(`t.departure_country ILIKE $${paramCount}`);
      queryParams.push(`%${departureCountry}%`);
      paramCount++;
    }

    if (departureCity) {
      whereConditions.push(`t.departure_city ILIKE $${paramCount}`);
      queryParams.push(`%${departureCity}%`);
      paramCount++;
    }

    if (destinationCountry) {
      whereConditions.push(`t.destination_country ILIKE $${paramCount}`);
      queryParams.push(`%${destinationCountry}%`);
      paramCount++;
    }

    if (destinationCity) {
      whereConditions.push(`t.destination_city ILIKE $${paramCount}`);
      queryParams.push(`%${destinationCity}%`);
      paramCount++;
    }

    // Filtres de dates
    if (departureDate) {
      whereConditions.push(`t.departure_date >= $${paramCount}`);
      queryParams.push(departureDate);
      paramCount++;
    }

    if (arrivalDate) {
      whereConditions.push(`t.arrival_date <= $${paramCount}`);
      queryParams.push(arrivalDate);
      paramCount++;
    }

    // Filtres de capacité et prix
    if (minWeight) {
      whereConditions.push(`t.available_weight >= $${paramCount}`);
      queryParams.push(minWeight);
      paramCount++;
    }

    if (maxPricePerKg) {
      whereConditions.push(`t.price_per_kg <= $${paramCount}`);
      queryParams.push(maxPricePerKg);
      paramCount++;
    }

    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    // Requête principale avec calcul de compatibilité
    const searchQuery = `
      SELECT 
        t.*,
        u.first_name,
        u.last_name,
        u.profile_picture,
        u.rating,
        u.total_ratings,
        u.is_verified,
        -- Calcul du poids déjà réservé
        COALESCE(reserved.total_weight, 0) as reserved_weight,
        (t.available_weight - COALESCE(reserved.total_weight, 0)) as actual_available_weight,
        -- Score de compatibilité (plus élevé = plus compatible)
        (
          CASE WHEN t.departure_date = $${departureDate ? queryParams.indexOf(departureDate) + 1 : 'NULL'} THEN 10 ELSE 0 END +
          CASE WHEN u.rating >= 4.0 THEN 5 ELSE 0 END +
          CASE WHEN u.is_verified THEN 3 ELSE 0 END +
          CASE WHEN t.available_weight >= ${minWeight || 0} * 2 THEN 2 ELSE 0 END
        ) as compatibility_score
      FROM trips t
      JOIN users u ON t.traveler_id = u.id
      LEFT JOIN (
        SELECT 
          trip_id, 
          SUM(weight) as total_weight
        FROM packages 
        WHERE status IN ('accepted', 'in_transit')
        GROUP BY trip_id
      ) reserved ON t.id = reserved.trip_id
      WHERE ${whereConditions.join(' AND ')}
      AND (t.available_weight - COALESCE(reserved.total_weight, 0)) > 0
      ORDER BY compatibility_score DESC, t.departure_date ASC, u.rating DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    const result = await db.query(searchQuery, queryParams);

    // Compter le total pour la pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM trips t
      LEFT JOIN (
        SELECT 
          trip_id, 
          SUM(weight) as total_weight
        FROM packages 
        WHERE status IN ('accepted', 'in_transit')
        GROUP BY trip_id
      ) reserved ON t.id = reserved.trip_id
      WHERE ${whereConditions.join(' AND ')}
      AND (t.available_weight - COALESCE(reserved.total_weight, 0)) > 0
    `;
    const countResult = await db.query(countQuery, queryParams.slice(0, -2));
    const total = parseInt(countResult.rows[0].total);

    const trips = result.rows.map(trip => ({
      id: trip.id,
      traveler: {
        id: trip.traveler_id,
        firstName: trip.first_name,
        lastName: trip.last_name,
        profilePicture: trip.profile_picture,
        rating: parseFloat(trip.rating),
        totalRatings: trip.total_ratings,
        isVerified: trip.is_verified
      },
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
        totalWeight: parseFloat(trip.available_weight),
        reservedWeight: parseFloat(trip.reserved_weight),
        availableWeight: parseFloat(trip.actual_available_weight),
        pricePerKg: parseFloat(trip.price_per_kg)
      },
      description: trip.description,
      status: trip.status,
      compatibilityScore: parseInt(trip.compatibility_score),
      createdAt: trip.created_at
    }));

    return {
      trips,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      },
      searchCriteria: criteria
    };

  } catch (error) {
    console.error('Erreur lors de la recherche de voyages:', error);
    throw error;
  }
};

/**
 * Trouve les demandes de colis compatibles avec un voyage donné
 * @param {number} tripId - ID du voyage
 * @param {number} travelerId - ID du voyageur
 * @returns {Array} Liste des colis compatibles
 */
const findMatchingPackagesForTrip = async (tripId, travelerId) => {
  try {
    const query = `
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.profile_picture,
        u.rating,
        u.total_ratings,
        u.is_verified,
        t.departure_country,
        t.departure_city,
        t.destination_country,
        t.destination_city,
        t.departure_date,
        t.arrival_date,
        t.available_weight,
        -- Calcul de compatibilité géographique et temporelle
        (
          CASE WHEN p.pickup_address ILIKE '%' || t.departure_city || '%' THEN 10 ELSE 0 END +
          CASE WHEN p.delivery_address ILIKE '%' || t.destination_city || '%' THEN 10 ELSE 0 END +
          CASE WHEN p.weight <= t.available_weight THEN 5 ELSE 0 END +
          CASE WHEN u.rating >= 4.0 THEN 3 ELSE 0 END +
          CASE WHEN u.is_verified THEN 2 ELSE 0 END
        ) as compatibility_score
      FROM packages p
      JOIN users u ON p.sender_id = u.id
      JOIN trips t ON $1 = $1  -- Trick pour joindre avec le voyage spécifique
      WHERE p.status = 'pending'
      AND p.weight <= t.available_weight
      AND t.id = $1
      AND p.sender_id != $2  -- Exclure les colis du voyageur lui-même
      AND (
        -- Compatibilité géographique flexible
        p.pickup_address ILIKE '%' || t.departure_country || '%'
        OR p.pickup_address ILIKE '%' || t.departure_city || '%'
      )
      AND (
        p.delivery_address ILIKE '%' || t.destination_country || '%'
        OR p.delivery_address ILIKE '%' || t.destination_city || '%'
      )
      ORDER BY compatibility_score DESC, p.created_at ASC
      LIMIT 20
    `;

    const result = await db.query(query, [tripId, travelerId]);

    return result.rows.map(pkg => ({
      id: pkg.id,
      sender: {
        id: pkg.sender_id,
        firstName: pkg.first_name,
        lastName: pkg.last_name,
        profilePicture: pkg.profile_picture,
        rating: parseFloat(pkg.rating),
        totalRatings: pkg.total_ratings,
        isVerified: pkg.is_verified
      },
      package: {
        title: pkg.title,
        description: pkg.description,
        weight: parseFloat(pkg.weight),
        dimensions: pkg.dimensions,
        value: parseFloat(pkg.value),
        totalPrice: parseFloat(pkg.total_price)
      },
      addresses: {
        pickup: pkg.pickup_address,
        delivery: pkg.delivery_address
      },
      status: pkg.status,
      compatibilityScore: parseInt(pkg.compatibility_score),
      createdAt: pkg.created_at
    }));

  } catch (error) {
    console.error('Erreur lors de la recherche de colis compatibles:', error);
    throw error;
  }
};

/**
 * Recherche de colis en attente pour un expéditeur
 * @param {Object} criteria - Critères de recherche
 * @returns {Object} Résultats de recherche
 */
const searchPendingPackages = async (criteria) => {
  try {
    const {
      departureCountry,
      destinationCountry,
      maxWeight,
      minPrice,
      maxPrice,
      page = 1,
      limit = 10
    } = criteria;

    let whereConditions = ['p.status = $1'];
    let queryParams = ['pending'];
    let paramCount = 2;

    if (departureCountry) {
      whereConditions.push(`p.pickup_address ILIKE $${paramCount}`);
      queryParams.push(`%${departureCountry}%`);
      paramCount++;
    }

    if (destinationCountry) {
      whereConditions.push(`p.delivery_address ILIKE $${paramCount}`);
      queryParams.push(`%${destinationCountry}%`);
      paramCount++;
    }

    if (maxWeight) {
      whereConditions.push(`p.weight <= $${paramCount}`);
      queryParams.push(maxWeight);
      paramCount++;
    }

    if (minPrice) {
      whereConditions.push(`p.total_price >= $${paramCount}`);
      queryParams.push(minPrice);
      paramCount++;
    }

    if (maxPrice) {
      whereConditions.push(`p.total_price <= $${paramCount}`);
      queryParams.push(maxPrice);
      paramCount++;
    }

    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    const searchQuery = `
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.profile_picture,
        u.rating,
        u.total_ratings,
        u.is_verified
      FROM packages p
      JOIN users u ON p.sender_id = u.id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY p.total_price DESC, p.created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    const result = await db.query(searchQuery, queryParams);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM packages p
      WHERE ${whereConditions.join(' AND ')}
    `;
    const countResult = await db.query(countQuery, queryParams.slice(0, -2));
    const total = parseInt(countResult.rows[0].total);

    const packages = result.rows.map(pkg => ({
      id: pkg.id,
      sender: {
        id: pkg.sender_id,
        firstName: pkg.first_name,
        lastName: pkg.last_name,
        profilePicture: pkg.profile_picture,
        rating: parseFloat(pkg.rating),
        totalRatings: pkg.total_ratings,
        isVerified: pkg.is_verified
      },
      package: {
        title: pkg.title,
        description: pkg.description,
        weight: parseFloat(pkg.weight),
        dimensions: pkg.dimensions,
        value: parseFloat(pkg.value),
        totalPrice: parseFloat(pkg.total_price)
      },
      addresses: {
        pickup: pkg.pickup_address,
        delivery: pkg.delivery_address
      },
      status: pkg.status,
      createdAt: pkg.created_at
    }));

    return {
      packages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    };

  } catch (error) {
    console.error('Erreur lors de la recherche de colis:', error);
    throw error;
  }
};

/**
 * Calcule la compatibilité entre un voyage et un colis
 * @param {Object} trip - Données du voyage
 * @param {Object} package - Données du colis
 * @returns {Object} Score de compatibilité et détails
 */
const calculateCompatibility = (trip, package) => {
  let score = 0;
  const details = {
    geographic: false,
    weight: false,
    timing: false,
    price: false
  };

  // Compatibilité géographique (40 points max)
  const departureMatch = 
    package.pickup_address.toLowerCase().includes(trip.departure_country.toLowerCase()) ||
    package.pickup_address.toLowerCase().includes(trip.departure_city.toLowerCase());
  
  const destinationMatch = 
    package.delivery_address.toLowerCase().includes(trip.destination_country.toLowerCase()) ||
    package.delivery_address.toLowerCase().includes(trip.destination_city.toLowerCase());

  if (departureMatch && destinationMatch) {
    score += 40;
    details.geographic = true;
  } else if (departureMatch || destinationMatch) {
    score += 20;
  }

  // Compatibilité de poids (30 points max)
  if (package.weight <= trip.available_weight) {
    score += 30;
    details.weight = true;
    
    // Bonus si le poids est optimal (50-80% de la capacité)
    const weightRatio = package.weight / trip.available_weight;
    if (weightRatio >= 0.5 && weightRatio <= 0.8) {
      score += 10;
    }
  }

  // Compatibilité temporelle (20 points max)
  const tripDate = new Date(trip.departure_date);
  const packageDate = new Date(package.created_at);
  const daysDiff = Math.abs((tripDate - packageDate) / (1000 * 60 * 60 * 24));
  
  if (daysDiff <= 7) {
    score += 20;
    details.timing = true;
  } else if (daysDiff <= 14) {
    score += 10;
  }

  // Compatibilité de prix (10 points max)
  const expectedPrice = package.weight * trip.price_per_kg;
  if (package.total_price >= expectedPrice * 0.9) {
    score += 10;
    details.price = true;
  }

  return {
    score,
    percentage: Math.min(100, score),
    details,
    recommendation: score >= 70 ? 'excellent' : score >= 50 ? 'good' : score >= 30 ? 'fair' : 'poor'
  };
};

module.exports = {
  searchTripsForSenders,
  findMatchingPackagesForTrip,
  searchPendingPackages,
  calculateCompatibility
};