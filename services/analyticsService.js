const db = require('../config/database');

class AnalyticsService {
  /**
   * Obtenir les statistiques générales d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} period - Période ('7d', '30d', '90d', '1y', 'all')
   */
  async getUserStats(userId, period = '30d') {
    try {
      const dateFilter = this.getDateFilter(period);
      
      // Statistiques des colis
      const packageStats = await this.getPackageStats(userId, dateFilter);
      
      // Statistiques des voyages
      const tripStats = await this.getTripStats(userId, dateFilter);
      
      // Statistiques des évaluations
      const ratingStats = await this.getRatingStats(userId);
      
      // Revenus et économies
      const financialStats = await this.getFinancialStats(userId, dateFilter);
      
      // Statistiques de géolocalisation
      const locationStats = await this.getLocationStats(userId, dateFilter);

      return {
        success: true,
        data: {
          period,
          packages: packageStats,
          trips: tripStats,
          ratings: ratingStats,
          financial: financialStats,
          location: locationStats,
          generatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques utilisateur:', error);
      throw error;
    }
  }

  /**
   * Obtenir les statistiques des colis pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} dateFilter - Filtre de date SQL
   */
  async getPackageStats(userId, dateFilter) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_packages,
          COUNT(CASE WHEN sender_id = $1 THEN 1 END) as sent_packages,
          COUNT(CASE WHEN traveler_id = $1 THEN 1 END) as delivered_packages,
          AVG(CASE WHEN sender_id = $1 THEN price END)::DECIMAL(10,2) as avg_sent_price,
          AVG(CASE WHEN traveler_id = $1 THEN price END)::DECIMAL(10,2) as avg_delivery_price,
          SUM(CASE WHEN sender_id = $1 THEN price ELSE 0 END)::DECIMAL(10,2) as total_sent_amount,
          SUM(CASE WHEN traveler_id = $1 THEN price ELSE 0 END)::DECIMAL(10,2) as total_earned_amount
        FROM packages p
        WHERE (sender_id = $1 OR traveler_id = $1)
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      // Statistiques par statut
      const statusQuery = `
        SELECT 
          pt.status,
          COUNT(*) as count
        FROM packages p
        JOIN package_tracking pt ON p.id = pt.package_id
        WHERE (p.sender_id = $1 OR p.traveler_id = $1)
        ${dateFilter ? `AND ${dateFilter.replace('p.', 'p.')}` : ''}
        AND pt.id IN (
          SELECT MAX(id) FROM package_tracking 
          WHERE package_id = p.id
        )
        GROUP BY pt.status
        ORDER BY count DESC
      `;

      const statusResult = await db.query(statusQuery, [userId]);
      const statusDistribution = {};
      statusResult.rows.forEach(row => {
        statusDistribution[row.status] = parseInt(row.count);
      });

      return {
        total: parseInt(stats.total_packages),
        sent: parseInt(stats.sent_packages),
        delivered: parseInt(stats.delivered_packages),
        averageSentPrice: parseFloat(stats.avg_sent_price) || 0,
        averageDeliveryPrice: parseFloat(stats.avg_delivery_price) || 0,
        totalSentAmount: parseFloat(stats.total_sent_amount) || 0,
        totalEarnedAmount: parseFloat(stats.total_earned_amount) || 0,
        statusDistribution
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques de colis:', error);
      return {
        total: 0,
        sent: 0,
        delivered: 0,
        averageSentPrice: 0,
        averageDeliveryPrice: 0,
        totalSentAmount: 0,
        totalEarnedAmount: 0,
        statusDistribution: {}
      };
    }
  }

  /**
   * Obtenir les statistiques des voyages pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} dateFilter - Filtre de date SQL
   */
  async getTripStats(userId, dateFilter) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_trips,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_trips,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_trips,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_trips,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600)::DECIMAL(10,2) as avg_duration_hours
        FROM trips
        WHERE traveler_id = $1
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      // Destinations les plus populaires
      const destinationsQuery = `
        SELECT 
          destination,
          COUNT(*) as trip_count
        FROM trips
        WHERE traveler_id = $1
        ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY destination
        ORDER BY trip_count DESC
        LIMIT 5
      `;

      const destinationsResult = await db.query(destinationsQuery, [userId]);
      const topDestinations = destinationsResult.rows;

      return {
        total: parseInt(stats.total_trips),
        completed: parseInt(stats.completed_trips),
        active: parseInt(stats.active_trips),
        cancelled: parseInt(stats.cancelled_trips),
        averageDurationHours: parseFloat(stats.avg_duration_hours) || 0,
        completionRate: stats.total_trips > 0 ? 
          (parseInt(stats.completed_trips) / parseInt(stats.total_trips) * 100).toFixed(2) : 0,
        topDestinations
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques de voyages:', error);
      return {
        total: 0,
        completed: 0,
        active: 0,
        cancelled: 0,
        averageDurationHours: 0,
        completionRate: 0,
        topDestinations: []
      };
    }
  }

  /**
   * Obtenir les statistiques d'évaluation pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   */
  async getRatingStats(userId) {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_ratings,
          AVG(rating)::DECIMAL(3,2) as average_rating,
          COUNT(CASE WHEN rating = 5 THEN 1 END) as five_stars,
          COUNT(CASE WHEN rating = 4 THEN 1 END) as four_stars,
          COUNT(CASE WHEN rating = 3 THEN 1 END) as three_stars,
          COUNT(CASE WHEN rating = 2 THEN 1 END) as two_stars,
          COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star,
          COUNT(CASE WHEN rating_type = 'sender' THEN 1 END) as as_sender,
          COUNT(CASE WHEN rating_type = 'traveler' THEN 1 END) as as_traveler
        FROM user_ratings
        WHERE rated_user_id = $1
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      return {
        totalRatings: parseInt(stats.total_ratings),
        averageRating: parseFloat(stats.average_rating) || 0,
        distribution: {
          fiveStars: parseInt(stats.five_stars),
          fourStars: parseInt(stats.four_stars),
          threeStars: parseInt(stats.three_stars),
          twoStars: parseInt(stats.two_stars),
          oneStar: parseInt(stats.one_star)
        },
        byType: {
          asSender: parseInt(stats.as_sender),
          asTraveler: parseInt(stats.as_traveler)
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques d\'évaluation:', error);
      return {
        totalRatings: 0,
        averageRating: 0,
        distribution: {
          fiveStars: 0,
          fourStars: 0,
          threeStars: 0,
          twoStars: 0,
          oneStar: 0
        },
        byType: {
          asSender: 0,
          asTraveler: 0
        }
      };
    }
  }

  /**
   * Obtenir les statistiques financières pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} dateFilter - Filtre de date SQL
   */
  async getFinancialStats(userId, dateFilter) {
    try {
      const query = `
        SELECT 
          SUM(CASE WHEN sender_id = $1 THEN price ELSE 0 END)::DECIMAL(10,2) as total_spent,
          SUM(CASE WHEN traveler_id = $1 THEN price ELSE 0 END)::DECIMAL(10,2) as total_earned,
          COUNT(CASE WHEN sender_id = $1 THEN 1 END) as packages_sent,
          COUNT(CASE WHEN traveler_id = $1 THEN 1 END) as packages_delivered,
          AVG(CASE WHEN sender_id = $1 THEN price END)::DECIMAL(10,2) as avg_package_cost,
          AVG(CASE WHEN traveler_id = $1 THEN price END)::DECIMAL(10,2) as avg_delivery_fee
        FROM packages
        WHERE (sender_id = $1 OR traveler_id = $1)
        ${dateFilter ? `AND ${dateFilter}` : ''}
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      // Évolution mensuelle des revenus
      const monthlyQuery = `
        SELECT 
          DATE_TRUNC('month', created_at) as month,
          SUM(CASE WHEN traveler_id = $1 THEN price ELSE 0 END)::DECIMAL(10,2) as earned,
          SUM(CASE WHEN sender_id = $1 THEN price ELSE 0 END)::DECIMAL(10,2) as spent
        FROM packages
        WHERE (sender_id = $1 OR traveler_id = $1)
        AND created_at >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month DESC
        LIMIT 12
      `;

      const monthlyResult = await db.query(monthlyQuery, [userId]);
      const monthlyEvolution = monthlyResult.rows.map(row => ({
        month: row.month,
        earned: parseFloat(row.earned) || 0,
        spent: parseFloat(row.spent) || 0
      }));

      return {
        totalSpent: parseFloat(stats.total_spent) || 0,
        totalEarned: parseFloat(stats.total_earned) || 0,
        netBalance: (parseFloat(stats.total_earned) || 0) - (parseFloat(stats.total_spent) || 0),
        packagesSent: parseInt(stats.packages_sent),
        packagesDelivered: parseInt(stats.packages_delivered),
        averagePackageCost: parseFloat(stats.avg_package_cost) || 0,
        averageDeliveryFee: parseFloat(stats.avg_delivery_fee) || 0,
        monthlyEvolution
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques financières:', error);
      return {
        totalSpent: 0,
        totalEarned: 0,
        netBalance: 0,
        packagesSent: 0,
        packagesDelivered: 0,
        averagePackageCost: 0,
        averageDeliveryFee: 0,
        monthlyEvolution: []
      };
    }
  }

  /**
   * Obtenir les statistiques de géolocalisation pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} dateFilter - Filtre de date SQL
   */
  async getLocationStats(userId, dateFilter) {
    try {
      const query = `
        SELECT 
          COUNT(DISTINCT tt.trip_id) as tracked_trips,
          COUNT(tl.id) as total_locations,
          AVG(EXTRACT(EPOCH FROM (tt.end_time - tt.start_time))/3600)::DECIMAL(10,2) as avg_tracking_hours,
          COUNT(CASE WHEN tt.share_with_senders = true THEN 1 END) as shared_trips
        FROM trip_tracking tt
        LEFT JOIN trip_locations tl ON tt.id = tl.tracking_id
        WHERE tt.traveler_id = $1
        ${dateFilter ? `AND ${dateFilter.replace('created_at', 'tt.created_at')}` : ''}
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      return {
        trackedTrips: parseInt(stats.tracked_trips) || 0,
        totalLocations: parseInt(stats.total_locations) || 0,
        averageTrackingHours: parseFloat(stats.avg_tracking_hours) || 0,
        sharedTrips: parseInt(stats.shared_trips) || 0,
        sharingRate: stats.tracked_trips > 0 ? 
          (parseInt(stats.shared_trips) / parseInt(stats.tracked_trips) * 100).toFixed(2) : 0
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques de géolocalisation:', error);
      return {
        trackedTrips: 0,
        totalLocations: 0,
        averageTrackingHours: 0,
        sharedTrips: 0,
        sharingRate: 0
      };
    }
  }

  /**
   * Obtenir les statistiques de litiges
   * @param {number} userId - ID de l'utilisateur
   * @param {string} period - Période
   */
  async getDisputeStats(userId, period = '30d') {
    try {
      const dateFilter = this.getDateFilter(period);
      
      const query = `
        SELECT 
          COUNT(*) as total_disputes,
          COUNT(CASE WHEN pd.status = 'open' THEN 1 END) as open_disputes,
          COUNT(CASE WHEN pd.status = 'resolved' THEN 1 END) as resolved_disputes,
          COUNT(CASE WHEN pd.status = 'closed' THEN 1 END) as closed_disputes,
          COUNT(CASE WHEN p.sender_id = $1 THEN 1 END) as as_sender,
          COUNT(CASE WHEN p.traveler_id = $1 THEN 1 END) as as_traveler
        FROM package_disputes pd
        JOIN packages p ON pd.package_id = p.id
        WHERE (p.sender_id = $1 OR p.traveler_id = $1)
        ${dateFilter ? `AND ${dateFilter.replace('created_at', 'pd.created_at')}` : ''}
      `;

      const result = await db.query(query, [userId]);
      const stats = result.rows[0];

      return {
        total: parseInt(stats.total_disputes),
        open: parseInt(stats.open_disputes),
        resolved: parseInt(stats.resolved_disputes),
        closed: parseInt(stats.closed_disputes),
        asSender: parseInt(stats.as_sender),
        asTraveler: parseInt(stats.as_traveler),
        resolutionRate: stats.total_disputes > 0 ? 
          (parseInt(stats.resolved_disputes) / parseInt(stats.total_disputes) * 100).toFixed(2) : 0
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques de litiges:', error);
      return {
        total: 0,
        open: 0,
        resolved: 0,
        closed: 0,
        asSender: 0,
        asTraveler: 0,
        resolutionRate: 0
      };
    }
  }

  /**
   * Obtenir les statistiques globales de la plateforme (admin)
   * @param {string} period - Période
   */
  async getPlatformStats(period = '30d') {
    try {
      const dateFilter = this.getDateFilter(period);
      
      // Statistiques des utilisateurs
      const userStatsQuery = `
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as new_users_30d,
          COUNT(CASE WHEN last_login >= NOW() - INTERVAL '7 days' THEN 1 END) as active_users_7d,
          COUNT(CASE WHEN role = 'admin' THEN 1 END) as admin_users
        FROM users
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
      `;

      // Statistiques des colis
      const packageStatsQuery = `
        SELECT 
          COUNT(*) as total_packages,
          SUM(price)::DECIMAL(10,2) as total_value,
          AVG(price)::DECIMAL(10,2) as avg_price,
          COUNT(CASE WHEN traveler_id IS NOT NULL THEN 1 END) as matched_packages
        FROM packages
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
      `;

      // Statistiques des voyages
      const tripStatsQuery = `
        SELECT 
          COUNT(*) as total_trips,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_trips,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_trips
        FROM trips
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
      `;

      const [userResult, packageResult, tripResult] = await Promise.all([
        db.query(userStatsQuery),
        db.query(packageStatsQuery),
        db.query(tripStatsQuery)
      ]);

      const userStats = userResult.rows[0];
      const packageStats = packageResult.rows[0];
      const tripStats = tripResult.rows[0];

      return {
        success: true,
        data: {
          period,
          users: {
            total: parseInt(userStats.total_users),
            new30d: parseInt(userStats.new_users_30d),
            active7d: parseInt(userStats.active_users_7d),
            admins: parseInt(userStats.admin_users)
          },
          packages: {
            total: parseInt(packageStats.total_packages),
            totalValue: parseFloat(packageStats.total_value) || 0,
            averagePrice: parseFloat(packageStats.avg_price) || 0,
            matched: parseInt(packageStats.matched_packages),
            matchingRate: packageStats.total_packages > 0 ? 
              (parseInt(packageStats.matched_packages) / parseInt(packageStats.total_packages) * 100).toFixed(2) : 0
          },
          trips: {
            total: parseInt(tripStats.total_trips),
            completed: parseInt(tripStats.completed_trips),
            active: parseInt(tripStats.active_trips),
            completionRate: tripStats.total_trips > 0 ? 
              (parseInt(tripStats.completed_trips) / parseInt(tripStats.total_trips) * 100).toFixed(2) : 0
          },
          generatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des statistiques de la plateforme:', error);
      throw error;
    }
  }

  /**
   * Obtenir le filtre de date SQL selon la période
   * @param {string} period - Période ('7d', '30d', '90d', '1y', 'all')
   */
  getDateFilter(period) {
    switch (period) {
      case '7d':
        return "created_at >= NOW() - INTERVAL '7 days'";
      case '30d':
        return "created_at >= NOW() - INTERVAL '30 days'";
      case '90d':
        return "created_at >= NOW() - INTERVAL '90 days'";
      case '1y':
        return "created_at >= NOW() - INTERVAL '1 year'";
      case 'all':
      default:
        return null;
    }
  }

  /**
   * Obtenir les tendances temporelles
   * @param {string} metric - Métrique ('packages', 'trips', 'users', 'revenue')
   * @param {string} period - Période
   * @param {string} granularity - Granularité ('day', 'week', 'month')
   */
  async getTimeTrends(metric, period = '30d', granularity = 'day') {
    try {
      let table, dateColumn, valueColumn, groupBy;
      
      switch (granularity) {
        case 'day':
          groupBy = "DATE_TRUNC('day', created_at)";
          break;
        case 'week':
          groupBy = "DATE_TRUNC('week', created_at)";
          break;
        case 'month':
          groupBy = "DATE_TRUNC('month', created_at)";
          break;
        default:
          groupBy = "DATE_TRUNC('day', created_at)";
      }

      switch (metric) {
        case 'packages':
          table = 'packages';
          valueColumn = 'COUNT(*)';
          break;
        case 'trips':
          table = 'trips';
          valueColumn = 'COUNT(*)';
          break;
        case 'users':
          table = 'users';
          valueColumn = 'COUNT(*)';
          break;
        case 'revenue':
          table = 'packages';
          valueColumn = 'SUM(price)::DECIMAL(10,2)';
          break;
        default:
          throw new Error('Métrique invalide');
      }

      const dateFilter = this.getDateFilter(period);
      
      const query = `
        SELECT 
          ${groupBy} as period,
          ${valueColumn} as value
        FROM ${table}
        ${dateFilter ? `WHERE ${dateFilter}` : ''}
        GROUP BY ${groupBy}
        ORDER BY period ASC
      `;

      const result = await db.query(query);
      
      return {
        success: true,
        data: {
          metric,
          period,
          granularity,
          trends: result.rows.map(row => ({
            period: row.period,
            value: parseFloat(row.value) || 0
          }))
        }
      };
    } catch (error) {
      console.error('Erreur lors de la récupération des tendances:', error);
      throw error;
    }
  }
}

module.exports = new AnalyticsService();