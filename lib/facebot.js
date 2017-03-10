var util = require("util");
var slackbots = require("slackbots");
var async = require("async");
var S = require("string");
var Q = require("q");
var _ = require("underscore")
var facebook = require("facebook-chat-api");
var fbUtil = require("./util");
var emoji = require("js-emoji");

// Load_data: function(callback(err, data))
// Save_data: function(data, callback(err))
//    data: { appState: object, channelLinks: [] }
var Facebot = function Constructor(settings, load_data, save_data){
    this.settings = settings;
    this.settings.name = this.settings.name || "facebot";
    this.user = null;
    this.facebookApi = null;
    
    this.load_data = load_data;
    this.save_data = save_data;
    
    // array of { slack_channel: string id, fb_thread: string id }
    this.channelLinks = [];
    this.fb_users = {};
    
    //emoji.init_env();
    emoji.replace_mode = 'unified';
    emoji.allow_native = true;
};

util.inherits(Facebot, slackbots);

Facebot.prototype.run = function(){    
    // Call the slackbots contructor, which immediately 
    // begins logging in
    Facebot.super_.call(this, this.settings);

    this.on('start', this.onStart);
    this.on('message', this.dispatchBotCommands);
    this.on('message', this.postSlackMessagesToFB);
    this.on('message', this.postGroupJoinedMessage);
};

Facebot.prototype.onStart = function(){
    this.setupUsers()
    .then(() => this.setupFacebook())
    .then(() => {
        if(!this.facebookApi)
            throw new Error("Unable to log into Facebook");
    })
    .done();
};

// Tries to grab the bot user and the authorised (facebook account) user
Facebot.prototype.setupUsers = function(){   
    var usernames = [
        this.settings.name, 
        this.settings.authorised_username
    ];
    var findUser = (username) => {
        return this.getUser(username)
        .then(user => {
            if(_.isEmpty(user)){
                throw new Error("User " + username + " not found.");
            } else {
                return user;
            }
        })
    };
    
    return Q.all(usernames.map(findUser, this))
            .spread((bot, auth) => {
                this.user = bot;
                this.authorised_user = auth;        
    });
};

// Attempts to log into facebook
Facebot.prototype.setupFacebook = function(){
    // Try to load the saved data and login to facebook
    // using the saved credentials. Otherwise fallback
    // to reloggin in with the email and pass
    return this.loadData()
    .then(data => {
        this.sendDebugMessage(`Loaded data, found ${data.channelLinks.length} channel links.`);
           
        // Load the linked channels
        this.channelLinks = data.channelLinks;
        return this.createFBApi(data);
    })
    .fail(err => {
        this.sendDebugMessage(`Couldn't log in with any saved data, logging in with email and pass (${err})`);
        
        var facebookConfig = {
            email: this.settings.facebook.email, 
            password: this.settings.facebook.pass
        };
        return this.createFBApi(facebookConfig);
    })
    .then(() => this.saveData());
}

// Loads the facebook tokens and channel links using
// the load_data callback passed into the constructor
Facebot.prototype.loadData = function(){
    return Q.Promise((resolve, reject) => {
        if(!this.load_data)
            return reject(new Error("no load data callback provided"));
        
        this.load_data(function(err, data){
            if(err){
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

// Saves the facebook tokens and channel links using
// the save_data callback passed into the constructor
Facebot.prototype.saveData = function()
{
    if(this.save_data && this.facebookApi){
        var data = { 
            appState: this.facebookApi.getAppState(),
            channelLinks: this.channelLinks 
        };
        this.save_data(data, function(err){
            if(err)
                console.log("Error saving facebot data: " + err);
            else 
                console.log("Saved Facebot settings");
        })
    }
}

// Creates the FB api using either saved tokens or username
// and password passed in as credentials
Facebot.prototype.createFBApi = function(credentials){
    return Q.nfcall(facebook, credentials)
           .then(api => {
                this.sendDebugMessage("Logged into facebook")
                
                this.facebookApi = api;
                api.setOptions({
                    logLevel: "error"
                });
                api.listen((err, fbmessage) => { 
                    if(!err)
                        this.postFBMessagesToSlack(fbmessage);
                });
           });
}

// Handles any facebook messages received, formats them
// and sends them through to the linked slack channels
Facebot.prototype.postFBMessagesToSlack = function(fbmessage){     
    _.where(this.channelLinks, { fb_thread: fbmessage.threadID.toString() })
    .forEach(link => {        
        var message_text = emoji.replace_emoticons_with_colons(fbmessage.body);
        this.postMessage(link.slack_channel,
                         message_text,
                         { username: link.fb_name,
                           icon_url: link.icon });
                           
        // Pass the message on, incase any attachements need to be handled
        this.handleFBAttachments(fbmessage, link);
    });
}

// Handles any facebook messages with attachments (stickers etc) 
Facebot.prototype.handleFBAttachments = function(fbmessage, link){
    fbmessage.attachments.forEach(attachment => {
        switch(attachment.type)
        {
            case "sticker": this.handleFBImageMessages(attachment.url, link); break;
            case "photo": this.handleFBImageMessages(attachment.hiresUrl, link); break;
            case "animated_image": this.handleFBImageMessages(attachment.rawGifImage, link); break;
            
            // Sharing urls etc. Post the raw URL and let slack do the preview
            case "share":
                this.postMessage(link.slack_channel,
                                 attachment.url,
                                 { username: link.fb_name,
                                 icon_url: link.icon });
                break;
            case "file":
                if(S(attachment.name).startsWith("audioclip"))
                    this.handleFBAudioMessages(attachment, link);
                break;
            case "video":
                this.handleFBVideoMessages(attachment, link);
                break;    
        }
    });
}

// Posts an image to the slack channel (in link) as the facebook sender
Facebot.prototype.handleFBImageMessages = function(imgurl, link){
    var attachments = [{ fallback: imgurl, 
                         image_url: imgurl }];
                         
    this.postMessage(link.slack_channel,
                     "",
                     { attachments: attachments,
                       username: link.fb_name,
                       icon_url: link.icon });
}

// Posts an audio message link to the slack channel (in link) as the facebook sender
Facebot.prototype.handleFBAudioMessages = function(attachment, link){
    this.postMessage(link.slack_channel,
                     `<${attachment.url}|Download Voice Message>`,
                     { username: link.fb_name,
                       icon_url: link.icon });
}

// Posts a video link and thumbnail to the slack channel (in link) as the facebook sender
Facebot.prototype.handleFBVideoMessages = function(attachment, link){
    // Convert the preview to an image attachment for slack
    var attachments = [{ fallback: attachment.previewUrl, 
                        image_url: attachment.previewUrl }];
                        
    this.postMessage(link.slack_channel,
                     `<${attachment.url}|Download Video (${attachment.duration} seconds)>`,
                     { attachments: attachments,
                       username: link.fb_name,
                       icon_url: link.icon });
}

// Handles forwarding any slack messages to facebook users
Facebot.prototype.postSlackMessagesToFB = function(message){
    if(this.isChatMessage(message) &&
       !this.isMessageFromFacebot(message) &&
       !this.isMessageMentioningFacebot(message))
    {        
        _.where(this.channelLinks, { slack_channel: message.channel })
        .forEach(link => {
            
            // Replace emoji shortnames with their unicode equiv
            var message_text = emoji.replace_colons(message.text);
            // Also replace :simple_smile: with :), as it doesnt appear to be 
            // a legit emoji, and will just send :simple_smile: to fb
            message_text = message_text.replace(":simple_smile:", ":)");
            
            this.facebookApi.sendMessage( 
                message_text,
                link.fb_thread,
                (err, msgInfo) => {
                    if(err)
                        this.postMessage(link.slack_channel,
                                         "Error sending last message: " + err.message,
                                         { as_user: true });
                });
        });
    }
}

// Attempts to link a slack channel to a facebook user
Facebot.prototype.respondToCreateChatMessages = function(message)
{
    var requiredUsers = [this.user.id, this.authorised_user.id];
    
    // Parse the friend name: "@facebot chat captain planet" becomes "captain planet"
    var friendname = message.text.substring(message.text.indexOf("chat") + "chat".length).trim();
    
    this.groupUsersOnlyContains(message.channel, requiredUsers)
    .then(isTruelyPrivate => {
        if(!isTruelyPrivate)
            throw new Error("The channel should only contain you and me.");
    })
    .then(() => fbUtil.findFriendUserByName(this.facebookApi, friendname))
    .then(friend => {
        this.channelLinks.push({ 
            slack_channel: message.channel,
            fb_thread: friend.id,
            fb_name: friend.name,
            icon: `http://graph.facebook.com/${friend.id}/picture?type=square`
        });
        this.saveData();
        
        return this.postMessage(message.channel, 
                                "Chat messages between you and " + friend.name + 
                                " are now synced in this channel.", 
                                { as_user: true });
    })
    .fail(err => {
        return this.postMessage(message.channel,
                                `Unable to connect the chat: ${err.message}`,
                                { as_user: true });
    });
}

// Unlinks the channel from any facebook friends
Facebot.prototype.respondToUnlinkCommands = function(message)
{
    var response;
    var matchingChannel = function (link){
        return link.slack_channel === message.channel;
    };
  
    if(_.some(this.channelLinks, matchingChannel)){
        this.channelLinks = _.reject(this.channelLinks, matchingChannel);
        this.saveData();
        response = "This channel is no longer connected to Facebook Messenger";
    } else {
        response = "This channel is not connected to any Facebook friends";
    }
    this.postMessage(message.channel,
                     response,
                     { as_user: true });
}

// Scans all slack messages, and if they appear to be a facebot
// command, gets facebot to run the command
Facebot.prototype.dispatchBotCommands = function(message){
    if(this.isChatMessage(message) &&
       !this.isMessageFromFacebot(message) &&
       !this.isBotMessage(message))
    {
        var command = "";
        var mention = `<@${this.user.id}>`;
        if(S(message.text).startsWith(mention)) {
            command = message.text.substring(mention.length + 1);
        } 
        else if(this.isMessageInDirectMessage(message)) {
            command = message.text;
        }
        
        // command should be single words, so grab the first word
        command = command.trim().toLowerCase().split(" ", 1)[0];
        if(command) 
            this.respondToCommands(command, message);
    }
}

// Handles facebot commands
Facebot.prototype.respondToCommands = function(command, message){
    if(command === "list")
        return this.postListOfLinkedChannels(message);
        
    if(command === "chat")
        return this.respondToCreateChatMessages(message);
    
    if(command == "unlink")
        return this.respondToUnlinkCommands(message);
    
    var response;
    if(command === "help") {        
        response = "`@facebot help`: See this text\n" +
                   "`@facebot chat <friend name>`: Connect a private channel with a facebook friend\n" +
                   "`@facebot unlink`: Disconnects the current channel from facebook messages\n" +
                   "`@facebot status`: Show facebook connectivity status\n" +
                   "`@facebot list`: Shows information about linked chats\n" + 
                   "_Note: In this Direct Message channel you can send commands without @mentioning facebot. For example:_\n" +
                   "`list`: list the linked chats in the current channel";
    }
    else if(command == "status"){
        response = "Facebook is currently *" + (this.facebookApi ? "connected*" : "not connected*");
    }
    
    if(response){
        this.postMessage(message.channel, response, { as_user: true });        
    }
}

// Posts a list of the currently linked chats, to the channel the 
// message came from
Facebot.prototype.postListOfLinkedChannels = function(message)
{
    if(this.channelLinks.length > 0){
        this.getGroups()
            .then(data => {
                // build a description of each link
                var linkDescriptions = this.channelLinks.map(link => {
                    var group = _.find(data.groups, group => group.id === link.slack_channel);
                    return `*${group.name}* is linked with *${link.fb_name}*`;
                })
                return this.postMessage(message.channel, 
                                        linkDescriptions.join("\n"), 
                                        { as_user: true });
            });
    } else {
        this.postMessage(message.channel, 
                         "There are currently no facebook chats linked to slack channels.", 
                         { as_user: true });
    }
}

// Posts a message when facebot is added to any groups, to inform 
// the user how to connect the channel to a facebook friend
Facebot.prototype.postGroupJoinedMessage = function(message){
    if(message.type == "group_joined"){
        var requiredUsers = [this.user.id, this.authorised_user.id];

        this.groupUsersOnlyContains(message.channel.id, requiredUsers)
        .then(isTruelyPrivate => {
           var join_message;
           if(isTruelyPrivate){
               join_message = "To connect a facebook chat type: \n" +
                              "@facebot chat `<friend name>`";
           } else {
                join_message = "You can only connect private channels where me and you are the only users."   
           }
           
           return this.postMessage(message.channel.id, join_message, { as_user: true });
        });
    }
}

// Sends a (slack) direct message to the authorised user if
// debug messages are enabled
Facebot.prototype.sendDebugMessage = function(message){
    if(this.settings.debug_messages){
        this.postMessageToUser(this.settings.authorised_username,
                               message, 
                               { as_user: true });
    }
}

Facebot.prototype.isChatMessage = function(message){
    return message.type === 'message' && Boolean(message.text);	
};

// Resolves a true promise if the channel with the id only 
// contains the users in userids
// users: array of userids
Facebot.prototype.groupUsersOnlyContains = function(channelid, userids){
    return this._api("groups.info", { channel: channelid } )
    .then(function(groupInfo){
        return _.isEmpty(_.difference(groupInfo.group.members, userids));
    })
    .fail(function(err){
        throw new Error("This is a not group channel.");
    });
}

Facebot.prototype.isMessageInDirectMessage = function(message){
    return typeof message.channel === 'string' &&
           message.channel[0] === 'D';
};

Facebot.prototype.isMessageFromFacebot = function(message){
    return message.user === this.user.id || this.isBotMessage(message);
}

Facebot.prototype.isMessageMentioningFacebot = function(message){
    var mention = `<@${this.user.id}>`;
    return message.text.indexOf(mention) > -1;
}

Facebot.prototype.isBotMessage = function(message){
    return message.subtype === "bot_message";
}

Facebot.prototype.isFromAuthorisedUser = function(message){
    return message.user === this.authorised_user.id;
};

module.exports = Facebot;
