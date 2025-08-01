const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

/**
 * Service Socket.IO pour la messagerie en temps réel ChapChap
 */

class SocketService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // userId -> socketId
    this.userSockets = new Map(); // socketId -> userId
  }

  /**
   * Initialiser Socket.IO
   * @param {Object} server - Serveur HTTP
   * @returns {Object} Instance Socket.IO
   */
  initialize(server) {
    this.io = socketIo(server, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3001",
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling']
    });

    // Middleware d'authentification
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return next(new Error('Token d\'authentification requis'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Vérifier que l'utilisateur existe
        const userResult = await db.query(
          'SELECT id, first_name, last_name, email FROM users WHERE id = $1',
          [decoded.userId]
        );

        if (userResult.rows.length === 0) {
          return next(new Error('Utilisateur non trouvé'));
        }

        socket.userId = decoded.userId;
        socket.user = userResult.rows[0];
        next();
      } catch (error) {
        console.error('Erreur d\'authentification Socket.IO:', error);
        next(new Error('Token invalide'));
      }
    });

    // Gestion des connexions
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    console.log('✅ Service Socket.IO initialisé');
    return this.io;
  }

  /**
   * Gérer une nouvelle connexion
   * @param {Object} socket - Socket client
   */
  handleConnection(socket) {
    const userId = socket.userId;
    
    console.log(`👤 Utilisateur connecté: ${userId} (${socket.user.first_name} ${socket.user.last_name})`);
    
    // Enregistrer la connexion
    this.connectedUsers.set(userId, socket.id);
    this.userSockets.set(socket.id, userId);
    
    // Rejoindre la room personnelle
    socket.join(`user_${userId}`);
    
    // Rejoindre les rooms des conversations actives
    this.joinUserConversations(socket, userId);
    
    // Notifier le statut en ligne
    this.broadcastUserStatus(userId, 'online');
    
    // Événements du socket
    this.setupSocketEvents(socket);
    
    // Gestion de la déconnexion
    socket.on('disconnect', () => {
      this.handleDisconnection(socket);
    });
  }

  /**
   * Configurer les événements du socket
   * @param {Object} socket - Socket client
   */
  setupSocketEvents(socket) {
    const userId = socket.userId;

    // Rejoindre une conversation
    socket.on('join_conversation', async (data) => {
      try {
        const { tripId, packageId } = data;
        
        // Vérifier l'accès à la conversation
        const accessQuery = `
          SELECT c.id FROM conversations c
          WHERE c.trip_id = $1 AND c.package_id = $2
          AND (c.sender_id = $3 OR c.traveler_id = $3)
        `;
        const accessResult = await db.query(accessQuery, [tripId, packageId, userId]);
        
        if (accessResult.rows.length > 0) {
          const roomName = `conversation_${tripId}_${packageId}`;
          socket.join(roomName);
          
          socket.emit('conversation_joined', {
            success: true,
            tripId,
            packageId,
            room: roomName
          });
          
          console.log(`📱 Utilisateur ${userId} a rejoint la conversation ${roomName}`);
        } else {
          socket.emit('conversation_error', {
            success: false,
            message: 'Accès non autorisé à cette conversation'
          });
        }
      } catch (error) {
        console.error('Erreur lors de la jointure de conversation:', error);
        socket.emit('conversation_error', {
          success: false,
          message: 'Erreur lors de la jointure de conversation'
        });
      }
    });

    // Quitter une conversation
    socket.on('leave_conversation', (data) => {
      const { tripId, packageId } = data;
      const roomName = `conversation_${tripId}_${packageId}`;
      socket.leave(roomName);
      
      socket.emit('conversation_left', {
        success: true,
        tripId,
        packageId
      });
      
      console.log(`📱 Utilisateur ${userId} a quitté la conversation ${roomName}`);
    });

    // Indicateur de frappe
    socket.on('typing_start', (data) => {
      const { tripId, packageId } = data;
      const roomName = `conversation_${tripId}_${packageId}`;
      
      socket.to(roomName).emit('user_typing', {
        userId,
        userName: `${socket.user.first_name} ${socket.user.last_name}`,
        tripId,
        packageId
      });
    });

    socket.on('typing_stop', (data) => {
      const { tripId, packageId } = data;
      const roomName = `conversation_${tripId}_${packageId}`;
      
      socket.to(roomName).emit('user_stopped_typing', {
        userId,
        tripId,
        packageId
      });
    });

    // Marquer les messages comme lus
    socket.on('mark_messages_read', async (data) => {
      try {
        const { tripId, packageId } = data;
        
        // Marquer les messages comme lus dans la base de données
        await db.query(
          `UPDATE messages SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
           WHERE trip_id = $1 AND package_id = $2 AND receiver_id = $3 AND is_read = FALSE`,
          [tripId, packageId, userId]
        );
        
        // Notifier l'autre utilisateur
        const roomName = `conversation_${tripId}_${packageId}`;
        socket.to(roomName).emit('messages_read', {
          tripId,
          packageId,
          readBy: userId
        });
        
        socket.emit('messages_marked_read', {
          success: true,
          tripId,
          packageId
        });
        
      } catch (error) {
        console.error('Erreur lors du marquage des messages:', error);
        socket.emit('messages_read_error', {
          success: false,
          message: 'Erreur lors du marquage des messages'
        });
      }
    });

    // Demander le statut en ligne des utilisateurs
    socket.on('get_user_status', (data) => {
      const { userIds } = data;
      const statuses = {};
      
      userIds.forEach(id => {
        statuses[id] = this.connectedUsers.has(id) ? 'online' : 'offline';
      });
      
      socket.emit('user_statuses', statuses);
    });

    // Événements de suivi des colis
    
    // Rejoindre une room de suivi de colis
    socket.on('join_package_tracking', async (data) => {
      try {
        const { packageId } = data;
        const roomName = `package_${packageId}`;
        
        await socket.join(roomName);
        console.log(`Utilisateur ${userId} a rejoint le suivi du colis ${packageId}`);
        
        socket.emit('package_tracking_joined', { packageId, room: roomName });
      } catch (error) {
        console.error('Erreur lors de la jointure du suivi:', error);
      }
    });
    
    // Quitter une room de suivi de colis
    socket.on('leave_package_tracking', async (data) => {
      try {
        const { packageId } = data;
        const roomName = `package_${packageId}`;
        
        await socket.leave(roomName);
        console.log(`Utilisateur ${userId} a quitté le suivi du colis ${packageId}`);
        
        socket.emit('package_tracking_left', { packageId, room: roomName });
      } catch (error) {
        console.error('Erreur lors de la sortie du suivi:', error);
      }
    });
    
    // Demander une mise à jour de statut
    socket.on('request_status_update', async (data) => {
      try {
        const { packageId, requestedStatus } = data;
        
        // Notifier les autres utilisateurs de la demande
        socket.to(`package_${packageId}`).emit('status_update_requested', {
          packageId,
          requestedStatus,
          requestedBy: userId,
          timestamp: new Date().toISOString()
        });
        
        console.log(`Demande de mise à jour de statut pour le colis ${packageId}: ${requestedStatus}`);
      } catch (error) {
        console.error('Erreur lors de la demande de mise à jour:', error);
      }
    });

    // Ping/Pong pour maintenir la connexion
    socket.on('ping', () => {
      socket.emit('pong');
    });
  }

  /**
   * Rejoindre les conversations actives de l'utilisateur
   * @param {Object} socket - Socket client
   * @param {number} userId - ID de l'utilisateur
   */
  async joinUserConversations(socket, userId) {
    try {
      const conversationsQuery = `
        SELECT trip_id, package_id FROM conversations
        WHERE sender_id = $1 OR traveler_id = $1
      `;
      const result = await db.query(conversationsQuery, [userId]);
      
      result.rows.forEach(conv => {
        const roomName = `conversation_${conv.trip_id}_${conv.package_id}`;
        socket.join(roomName);
      });
      
      console.log(`📱 Utilisateur ${userId} a rejoint ${result.rows.length} conversations`);
    } catch (error) {
      console.error('Erreur lors de la jointure des conversations:', error);
    }
  }

  /**
   * Gérer la déconnexion
   * @param {Object} socket - Socket client
   */
  handleDisconnection(socket) {
    const userId = this.userSockets.get(socket.id);
    
    if (userId) {
      console.log(`👤 Utilisateur déconnecté: ${userId}`);
      
      // Supprimer de la liste des connectés
      this.connectedUsers.delete(userId);
      this.userSockets.delete(socket.id);
      
      // Notifier le statut hors ligne
      this.broadcastUserStatus(userId, 'offline');
    }
  }

  /**
   * Diffuser le statut d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} status - Statut (online/offline)
   */
  broadcastUserStatus(userId, status) {
    this.io.emit('user_status_changed', {
      userId,
      status,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Envoyer une notification de nouveau message
   * @param {number} receiverId - ID du destinataire
   * @param {Object} messageData - Données du message
   */
  notifyNewMessage(receiverId, messageData) {
    if (!this.io) return;
    
    // Envoyer à l'utilisateur spécifique
    this.io.to(`user_${receiverId}`).emit('new_message', messageData);
    
    // Envoyer à la conversation
    const { tripId, packageId } = messageData.message;
    if (tripId && packageId) {
      this.io.to(`conversation_${tripId}_${packageId}`).emit('conversation_message', messageData);
    }
    
    console.log(`📨 Notification envoyée à l'utilisateur ${receiverId}`);
  }

  /**
   * Obtenir le nombre d'utilisateurs connectés
   * @returns {number} Nombre d'utilisateurs connectés
   */
  getConnectedUsersCount() {
    return this.connectedUsers.size;
  }

  /**
   * Vérifier si un utilisateur est en ligne
   * @param {number} userId - ID de l'utilisateur
   * @returns {boolean} Statut en ligne
   */
  isUserOnline(userId) {
    return this.connectedUsers.has(userId);
  }

  /**
   * Obtenir la liste des utilisateurs connectés
   * @returns {Array} Liste des IDs des utilisateurs connectés
   */
  getConnectedUsers() {
    return Array.from(this.connectedUsers.keys());
  }

  /**
   * Envoyer une notification système
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} notification - Données de notification
   */
  sendSystemNotification(userId, notification) {
    if (!this.io) return;
    
    this.io.to(`user_${userId}`).emit('system_notification', {
      ...notification,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Diffuser une notification à tous les utilisateurs connectés
   * @param {Object} notification - Données de notification
   */
  broadcastNotification(notification) {
    if (!this.io) return;
    
    this.io.emit('broadcast_notification', {
      ...notification,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Notifier un changement de statut de colis
   * @param {Object} trackingData - Données de suivi
   */
  notifyPackageStatusUpdate(trackingData) {
    if (!this.io) return;
    
    try {
      const { packageId, status, userId, notes, location, photoPath } = trackingData;
      
      const notification = {
        type: 'package_status_update',
        packageId,
        status,
        updatedBy: userId,
        notes,
        location,
        photoPath,
        timestamp: new Date().toISOString()
      };
      
      // Notifier dans la room du colis
      this.io.to(`package_${packageId}`).emit('package_status_updated', notification);
      
      // Notifier les utilisateurs connectés impliqués dans ce colis
      this.io.emit('package_notification', {
        ...notification,
        message: `Le statut du colis a été mis à jour: ${status}`
      });
      
      console.log('Notification de mise à jour de statut envoyée:', {
        packageId,
        status,
        userId
      });
    } catch (error) {
      console.error('Erreur lors de la notification de statut:', error);
    }
  }

  /**
   * Notifier la création d'un litige
   * @param {Object} disputeData - Données du litige
   */
  notifyDisputeCreated(disputeData) {
    if (!this.io) return;
    
    try {
      const { packageId, disputeId, reporterId, reason } = disputeData;
      
      const notification = {
        type: 'dispute_created',
        packageId,
        disputeId,
        reporterId,
        reason,
        timestamp: new Date().toISOString()
      };
      
      // Notifier dans la room du colis
      this.io.to(`package_${packageId}`).emit('dispute_created', notification);
      
      // Notifier les administrateurs (si implémenté)
      this.io.to('admin_room').emit('new_dispute', notification);
      
      console.log('Notification de litige créé envoyée:', {
        packageId,
        disputeId,
        reporterId
      });
    } catch (error) {
      console.error('Erreur lors de la notification de litige:', error);
    }
  }

  /**
   * Notifier une demande de confirmation de livraison
   * @param {Object} deliveryData - Données de livraison
   */
  notifyDeliveryConfirmationRequest(deliveryData) {
    if (!this.io) return;
    
    try {
      const { packageId, travelerId, senderId } = deliveryData;
      
      const notification = {
        type: 'delivery_confirmation_request',
        packageId,
        travelerId,
        senderId,
        timestamp: new Date().toISOString()
      };
      
      // Notifier le destinataire pour confirmation
      if (this.connectedUsers.has(senderId.toString())) {
        this.io.to(this.connectedUsers.get(senderId.toString())).emit('delivery_confirmation_requested', notification);
      }
      
      // Notifier dans la room du colis
      this.io.to(`package_${packageId}`).emit('delivery_confirmation_requested', notification);
      
      console.log('Demande de confirmation de livraison envoyée:', {
        packageId,
        travelerId,
        senderId
      });
    } catch (error) {
      console.error('Erreur lors de la demande de confirmation:', error);
    }
  }

  /**
   * Notifier le début du suivi de géolocalisation
   * @param {number} tripId - ID du voyage
   * @param {number} travelerId - ID du voyageur
   * @param {Object} trackingDetails - Détails du suivi
   */
  notifyTrackingStarted(tripId, travelerId, trackingDetails) {
    if (!this.io) return;
    
    try {
      const notification = {
        type: 'tracking_started',
        tripId,
        travelerId,
        trackingDetails,
        message: 'Le suivi de géolocalisation a commencé',
        timestamp: new Date().toISOString()
      };
      
      // Notifier tous les expéditeurs concernés par ce voyage
      this.io.to(`trip_${tripId}`).emit('tracking_started', notification);
      
      console.log('Notification de début de suivi envoyée:', {
        tripId,
        travelerId
      });
    } catch (error) {
      console.error('Erreur lors de la notification de début de suivi:', error);
    }
  }

  /**
   * Diffuser une mise à jour de position
   * @param {number} tripId - ID du voyage
   * @param {Object} locationData - Données de géolocalisation
   */
  broadcastLocationUpdate(tripId, locationData) {
    if (!this.io) return;
    
    try {
      const notification = {
        type: 'location_update',
        tripId,
        location: locationData,
        timestamp: new Date().toISOString()
      };
      
      // Diffuser la mise à jour de position à tous les utilisateurs suivant ce voyage
      this.io.to(`trip_${tripId}`).emit('location_update', notification);
      
      console.log('Mise à jour de position diffusée:', {
        tripId,
        location: locationData
      });
    } catch (error) {
      console.error('Erreur lors de la diffusion de position:', error);
    }
  }

  /**
   * Notifier l'arrêt du suivi de géolocalisation
   * @param {number} tripId - ID du voyage
   * @param {number} travelerId - ID du voyageur
   */
  notifyTrackingStopped(tripId, travelerId) {
    if (!this.io) return;
    
    try {
      const notification = {
        type: 'tracking_stopped',
        tripId,
        travelerId,
        message: 'Le suivi de géolocalisation s\'est arrêté',
        timestamp: new Date().toISOString()
      };
      
      // Notifier la fin du suivi
      this.io.to(`trip_${tripId}`).emit('tracking_stopped', notification);
      
      console.log('Notification d\'arrêt de suivi envoyée:', {
        tripId,
        travelerId
      });
    } catch (error) {
      console.error('Erreur lors de la notification d\'arrêt de suivi:', error);
    }
  }

  /**
   * Notifier les colis à proximité
   * @param {number} travelerId - ID du voyageur
   * @param {Array} packages - Liste des colis à proximité
   */
  notifyNearbyPackages(travelerId, packages) {
    if (!this.io) return;
    
    try {
      const notification = {
        type: 'nearby_packages',
        packages,
        message: `${packages.length} colis trouvés à proximité`,
        timestamp: new Date().toISOString()
      };
      
      // Notifier le voyageur des colis à proximité
      this.io.to(`user_${travelerId}`).emit('nearby_packages', notification);
      
      console.log('Notification de colis à proximité envoyée:', {
        travelerId,
        packagesCount: packages.length
      });
    } catch (error) {
      console.error('Erreur lors de la notification de colis à proximité:', error);
    }
  }

  /**
   * Notifier une mise à jour de suivi visuel
   * @param {number} packageId - ID du colis
   * @param {Object} trackingData - Données de suivi
   */
  notifyTrackingUpdate(packageId, trackingData) {
    try {
      this.io.to(`package_${packageId}`).emit('tracking_update', {
        packageId,
        ...trackingData,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erreur lors de la notification de mise à jour de suivi:', error);
    }
  }

  /**
   * Notifier l'ajout d'une nouvelle photo
   * @param {number} packageId - ID du colis
   * @param {Object} photoData - Données de la photo
   */
  notifyPhotoAdded(packageId, photoData) {
    try {
      this.io.to(`package_${packageId}`).emit('photo_added', {
        packageId,
        ...photoData,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erreur lors de la notification d\'ajout de photo:', error);
    }
  }

  /**
   * Notifier une nouvelle évaluation
   * @param {number} userId - ID de l'utilisateur évalué
   * @param {Object} ratingData - Données de l'évaluation
   */
  notifyNewRating(userId, ratingData) {
    try {
      this.io.to(`user_${userId}`).emit('new_rating', {
        ...ratingData,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erreur lors de la notification de nouvelle évaluation:', error);
    }
  }

  /**
   * Notifier les statistiques mises à jour
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} stats - Nouvelles statistiques
   */
  notifyStatsUpdate(userId, stats) {
    try {
      this.io.to(`user_${userId}`).emit('stats_update', {
        ...stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erreur lors de la notification de mise à jour des statistiques:', error);
    }
  }

  /**
   * Notifier une livraison imminente
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} deliveryData - Données de livraison
   */
  notifyDeliveryImminent(userId, deliveryData) {
    try {
      this.io.to(`user_${userId}`).emit('delivery_imminent', {
        ...deliveryData,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erreur lors de la notification de livraison imminente:', error);
    }
  }
}

// Instance singleton
const socketService = new SocketService();

module.exports = socketService;