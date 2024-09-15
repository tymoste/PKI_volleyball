const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const sequelize = new Sequelize('postgresql://volley_project_owner:M9sZB8ubWTIe@ep-billowing-wind-a2o8oz70.eu-central-1.aws.neon.tech/volley_project?sslmode=require');

//Match model
const Match = sequelize.define('Match', {
    date: {
      type: DataTypes.DATE,
      allowNull: false
    },
    teamA_name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    teamB_name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    result: {
      type: DataTypes.STRING,
      allowNull: true
    },
    resultDetailed: {
      type: DataTypes.JSON,
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('PLANNED', 'IN_PROGRESS', 'FINISHED'),
      defaultValue: 'PLANNED'
    }
  }, {
    timestamps: false
  });

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.json());
  app.use(express.static('public'));

  //Redirect from root to '/matches'
  app.get('/',(req, res)=>{
    res.redirect('/matches');
  });

  //Gets full list of matches ordered by date ascending with option to sort matches out
  app.get('/matches', async (req, res)=>{

    let status = req.query.status;
    let options = {
      order: [['date', 'ASC']]
    };

    if(!(['PLANNED', 'ALL', 'FINISHED', 'IN_PROGRESS'].includes(status))){
      status = 'ALL';
    }

    if(status && status !== 'ALL'){
      options.where = {
        status: status
      };
    }

    const matches = await Match.findAll(options);

    res.render('index', {matches});
  });

  //Rendering of add-match view
  app.get('/add-match', (req, res)=>{
    res.render('add-match');
  })

  //Logic of new match
  app.post('/matches', async (req, res) => {
    try {
      const { teamA_name, teamB_name, date, status } = req.body;
  
      const newMatch = await Match.create({
        teamA_name,
        teamB_name,
        date,
        status,
        result: '0:0',
        resultDetailed: {'resD': ['0:0']}
      });
      
      //emiting to all clients that new match showed up
      io.emit('match_created', newMatch);
      res.status(201).json(newMatch);
    } catch (error) {
      console.error(error);
      res.status(500).send('Server error');
    }
  });

  //Rendering the match view based on id passed
  app.get('/matches/:id', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
        res.render('match', { match });
    } else {
        res.status(404).send('Match not found');
    }
  });

  //Endpoint for copying to clipboard, returns just json - no rendering
  app.get('/matches/copy/:id', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
        res.json(match);
    } else {
        res.status(404).send('Match not found');
    }
  });

  // Endpoint for ending whole match
  app.put('/matches/:id/end-match', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
      const resultDetailed = JSON.parse(JSON.stringify(match.resultDetailed));
      //Triming redundant array entries
      resultDetailed.resD.pop();
      //Updating values
      await match.update({
        status: 'FINISHED',
        resultDetailed: resultDetailed
      })
      console.log(resultDetailed)
      //Emiting to all users that match is updated
      io.emit('match_updated');
      //Stoping and deleting timers
      if(startedMatches[req.params.id]){
          clearInterval(startedMatches[req.params.id].intervalId);
          delete startedMatches[req.params.id];
      }
      //Emiting to clients observing a match that match has ended
      io.to(`match_${match.id}`).emit('end_match');
      res.json(match);
    } else {
      res.status(404).send('Match not found');
    }
  })
  //Endpoint to swap sides
  app.get('/matches/:id/swap-sides', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
      if(!startedMatches[req.params.id]){
        startedMatches[req.params.id] = {
          teamsPosition: true
        }
      } else {
        startedMatches[req.params.id].teamsPosition = !startedMatches[req.params.id].teamsPosition;
      }
      io.to(`match_${req.params.id}`).emit('swap_sides', { 
        flag: startedMatches[req.params.id].teamsPosition
       });
      res.json(match);
    } else {
      res.status(404).send('Match not found');
    }
  })

  //Endpoint for ending set
  app.put('/matches/:id/end-set', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
      //Processing data to increment points
      const currSet = match.resultDetailed.resD[match.resultDetailed.resD.length - 1].split(':');
      console.log(match.resultDetailed);
      let scoreA = parseInt(currSet[0]);
      let scoreB = parseInt(currSet[1]);

      const result = match.result.split(':');
      let resScoreA = parseInt(result[0]);
      let resScoreB = parseInt(result[1]);

      let winning = scoreA - scoreB;
      if(winning > 0){
        resScoreA += 1;
      } else {
        resScoreB += 1;
      }

      console.log(`${resScoreA}:${resScoreB}`);

      const finalResult = `${resScoreA}:${resScoreB}`;
      const resultDetailed = JSON.parse(JSON.stringify(match.resultDetailed));
      resultDetailed.resD[match.resultDetailed.resD.length] = '0:0';
      console.log(finalResult);
      console.log(resultDetailed.resD);
      //Updating match
      await match.update({
        result: finalResult,
        resultDetailed: resultDetailed
      });
      console.log(match.result);
      const setOver = 0;
      let matchOver = 0;

      if(resScoreA === 3 || resScoreB === 3){
        matchOver = 1;
      }
      //Clearing set timers
      if(startedMatches[match.id]){
        clearInterval(startedMatches[match.id].setInterval);
        startedMatches[match.id].setInterval = null;
        startedMatches[match.id].setTimeStart = null;
      }

      //Emiting to clients watching match about new points
      io.to(`match_${match.id}`).emit('score_update', {
        scoreA: 0,
        scoreB: 0,
        setOver,
        matchOver,
        match
      });
      //Emiting to everyone that set score is changed
      io.emit('match_updated', match);
      startedMatches[match.id].teamsPosition = !startedMatches[match.id].teamsPosition;
      io.to(`match_${match.id}`).emit('swap_sides', {
        flag: startedMatches[match.id].teamsPosition
      })

    } else {
      res.status(404).send('Match not found');
    }
  })

  //Endpoint to subtract a point
  app.put('/matches/:id/sub-score', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
      //Porcesing data
      const { team } = req.body;
      const currSet = match.resultDetailed.resD[match.resultDetailed.resD.length - 1].split(':');
      console.log(match.resultDetailed);
      let scoreA = parseInt(currSet[0]);
      let scoreB = parseInt(currSet[1]);

      const result = match.result.split(':');
      let resScoreA = parseInt(result[0]);
      let resScoreB = parseInt(result[1])

      if(team === match.teamA_name){
        if(scoreA !== 0){
          scoreA -= 1;
        }
      } else if(team === match.teamB_name){
        if(scoreB !== 0){
          scoreB -= 1;
        }
      }

      let setOver = 0;
      let winning = scoreA - scoreB;

      const tieBreak = (resScoreA === 2 && resScoreB === 2);

      if((scoreA === 7 || scoreB === 7) && tieBreak && scoreA + scoreB < 16){
        startedMatches[match.id].teamsPosition = !startedMatches[match.id].teamsPosition;
        io.to(`match_${match.id}`).emit('swap_sides', {
          flag: startedMatches[match.id].teamsPosition
        })
      }

      //Logic for ending set
      if(tieBreak){
        setOver = (scoreA >= 15 || scoreB >= 15) && Math.abs(winning) >= 2;
      } else {
        setOver = (scoreA >= 25 || scoreB >= 25) && Math.abs(winning) >= 2;
      }

      const resultDetailed = JSON.parse(JSON.stringify(match.resultDetailed));
      resultDetailed.resD[resultDetailed.resD.length - 1] = `${scoreA}:${scoreB}`;
      //Updating
      await match.update({
        resultDetailed: resultDetailed
      });

      io.to(`match_${match.id}`).emit('score_update', {
        scoreA,
        scoreB,
        setOver,
        match
      });
    } else {
      res.status(404).send('Match not found');
    }
  });

  //Endpoint for adding points
  app.put('/matches/:id/score', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
      //Processing data
      const { team } = req.body;
      const currSet = match.resultDetailed.resD[match.resultDetailed.resD.length - 1].split(':');
      console.log(match.resultDetailed);
      let scoreA = parseInt(currSet[0]);
      let scoreB = parseInt(currSet[1]);

      const result = match.result.split(':');
      let resScoreA = parseInt(result[0]);
      let resScoreB = parseInt(result[1]);

      if(team === match.teamA_name){
        scoreA += 1;
      } else if(team === match.teamB_name){
        scoreB += 1;
      }

      let setOver = 0;
      let winning = scoreA - scoreB;

      const tieBreak = (resScoreA === 2 && resScoreB === 2);

      if((scoreA === 8 || scoreB === 8) && tieBreak && scoreA + scoreB < 16){
        startedMatches[match.id].teamsPosition = !startedMatches[match.id].teamsPosition;
        io.to(`match_${match.id}`).emit('swap_sides', {
          flag: startedMatches[match.id].teamsPosition
        })
      }

      //Logic for ending set
      if(tieBreak){
        setOver = (scoreA >= 15 || scoreB >= 15) && Math.abs(winning) >= 2;
      } else {
        setOver = (scoreA >= 25 || scoreB >= 25) && Math.abs(winning) >= 2;
      }

      const resultDetailed = JSON.parse(JSON.stringify(match.resultDetailed));
      resultDetailed.resD[resultDetailed.resD.length - 1] = `${scoreA}:${scoreB}`;
      console.log(match.resultDetailed);
      //Updating points
      await match.update({
        status: 'IN_PROGRESS',
        resultDetailed: resultDetailed
      })
      console.log(match.resultDetailed);
      //Emmiting to observers new points
      io.to(`match_${match.id}`).emit('score_update', {
        scoreA,
        scoreB,
        setOver,
        match
      });

      //Starting match timers
      if ((!startedMatches[match.id] || startedMatches[match.id].intervalId === undefined) && match.status === 'IN_PROGRESS') {
        const matchStartTime = new Date(match.date);
        const now = new Date();
        let tempDate = now;
        tempDate.setSeconds(0);
        tempDate.setMilliseconds(0);
        let gameTime = 0;

        await match.update({
          date: tempDate
        })

        if (matchStartTime <= now) {
            gameTime = Math.floor((now - matchStartTime) / 1000);
        }

        startedMatches[match.id] = {
            startTime: matchStartTime,
            gameTime: gameTime,
            intervalId: setInterval(() => {
                startedMatches[match.id].gameTime += 1;
                io.to(`match_${match.id}`).emit('time_update', {
                  currentTime: new Date().toLocaleTimeString(),
                  gameTime: startedMatches[match.id] ? startedMatches[match.id].gameTime : 0
              });
            }, 1000)
        };
      }

      if(startedMatches[match.id]){
        if(!startedMatches[match.id].setTimeStart){
          startedMatches[match.id].setTimeStart = new Date().getTime();
          startedMatches[match.id].setInterval = setInterval(()=>{
            const currTime = new Date();
            const setTimeStart = startedMatches[match.id].setTimeStart;

            if(setTimeStart){
              const setTimer = Math.floor((currTime.getTime() - setTimeStart)/1000);
              io.to(`match_${match.id}`).emit('set_time_update', {
                setTimer: setTimer
              });
            }
          }, 1000)
        }
      }

      res.json({ success: true, scoreA, scoreB, setOver });
    } else {
      res.status(404).send('Match not found');
    }
  });
  
  //Ednpoint for deleting match
  app.delete('/matches/:id', async (req, res)=>{
    const match = await Match.findByPk(req.params.id);
    if(match){
      //Clearing intervals
      if(startedMatches[req.params.id]){
        clearInterval(startedMatches[req.params.id].intervalId);
        clearInterval(startedMatches[req.params.id].setInterval);
        delete startedMatches[req.params.id];
      }
        // kicking all from a room
        io.to(`match_${match.id}`).emit('end_match');
        await match.destroy();
        //Emiting to all clients about deletion
        io.emit('match_deleted', match);
        res.status(201).send();
    } else {
        res.status(404).send('Match not found');
    }
  });

  const startedMatches = {};

  //Socket config
  io.on('connection', (socket)=>{
    console.log('User connected');

    //Joining match
    socket.on('join_match', async (matchId) => {
      console.log(`User joined match ${matchId}`);
      socket.join(`match_${matchId}`);
      //Getting timers of a match
      const match = await Match.findByPk(matchId);
      if (match) {
        //Checking what side should be a team on
        if(startedMatches[matchId] && typeof startedMatches[matchId] !== undefined){
          io.to(`match_${matchId}`).emit('swap_sides', {
            flag: startedMatches[matchId].teamsPosition
          })
        } else {
          startedMatches[matchId] = {
            teamsPosition: false
          }
          io.to(`match_${matchId}`).emit('swap_sides', {
            flag: startedMatches[matchId].teamsPosition
          })
        }
          if (!startedMatches[matchId] && match.status === 'IN_PROGRESS') {
              const matchStartTime = new Date(match.date);
              const now = new Date();
              let gameTime = 0;

              if (matchStartTime <= now) {
                  gameTime = Math.floor((now - matchStartTime) / 1000);
              }

              startedMatches[matchId] = {
                  startTime: matchStartTime,
                  gameTime: gameTime,
                  intervalId: setInterval(() => {
                      startedMatches[matchId].gameTime += 1;
                      io.to(`match_${matchId}`).emit('time_update', {
                        currentTime: new Date().toLocaleTimeString(),
                        gameTime: startedMatches[matchId] ? startedMatches[matchId].gameTime : 0
                    });
                  }, 1000)
              };
          }
      }
  });

    //Leaving match
    socket.on('leave_match', (matchId)=>{
        console.log(`User left match ${matchId}`);
        socket.leave(`match_${matchId}`);
    });

    //Disconnecting
    socket.on('disconnect', ()=>{
        console.log('User disconnected');
    });
  });

  //Syncing database and starting seerver
  sequelize.sync().then(()=>{
    server.listen(3000, ()=>{
        console.log('Server is listening on port 3000');
    });
  });