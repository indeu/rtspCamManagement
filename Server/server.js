// initialize
var express = require('express'),
fs      = require('fs'),
app     = express(),
eps     = require('ejs'),
morgan  = require('morgan');

// Amazon Rek
const AWS = require('aws-sdk');
const path = require("path");
const BUCKET_NAME = 'rekognition-test';

// Local ffmpeg
var spawn = require('child_process').spawn;
var cmd = '/home/ubuntu/bin/ffmpeg';
var args = [
    '-y', 
    '-i', '/home/ubuntu/input.flv',
    '-s', '640x480', 
    '-codec:a', 'aac', 
    '-b:a', '44.1k', 
    '-r', '15', 
    '-b:v', '1000k', 
    '-c:v','h264', 
    '-f', 'mp4', '/home/ubuntu/output.mp4'
];

var async = require('async');
var http = require("http");
var https = require("https");
var apn = require('apn');

Object.assign=require('object-assign')

app.engine('html', require('ejs').renderFile);
app.use(morgan('combined'))

var getDateTime = function() {
  var date = new Date();
  var hour = date.getHours();
  hour = (hour < 10 ? "0" : "") + hour;
  var min  = date.getMinutes();
  min = (min < 10 ? "0" : "") + min;
  var sec  = date.getSeconds();
  sec = (sec < 10 ? "0" : "") + sec;
  var year = date.getFullYear();
  var month = date.getMonth() + 1;
  month = (month < 10 ? "0" : "") + month;
  var day  = date.getDate();
  day = (day < 10 ? "0" : "") + day;

  return year + "-" + month + "-" + day + " " + hour + ":";// + min;// + ":" + sec;
}

app.get('/', function (req, res) {
  // try to initialize the db on every request if it's not already
  // initialized.
  var link = "Images/180404-floppy.png";
  res.send("<html><body><img src='" + link + "'></body></html>");
});

// error handling
app.use(function(err, req, res, next){
  res.setHeader('Access-Control-Allow-Origin', '*');
  console.error(err.stack);
  res.status(500).send('Something bad happened!');
});

var ip = '127.0.0.1';
var port = 8080;
app.listen(port, ip);
console.log('Server running on http://%s:%s', ip, port);
module.exports = app;

function runFFMpeg(){
  var proc = spawn(cmd, args);

  proc.stdout.on('data', function(data) {
      console.log(data);
  });
  
  proc.stderr.on('data', function(data) {
      console.log(data);
  });
  
  proc.on('close', function() {
      console.log('finished');
  });  
}

function getImageMetadata(){
  return new Promise((resolve, reject)=>{

    const imagesPath = path.join(__dirname, "../Images/");
    console.log(`Reading images from ${imagesPath}`);

    fs.readdir(imagesPath, function(err, items) {  
      if (err){
        console.log(err, err.stack);
        reject(err);
        return;
      }

      resolve(items.map((i)=>{
        return {
          id : path.basename(i).toLocaleLowerCase(),
          filename: path.join(imagesPath, i)
        };
      }));

    });

  });
}

function getBucketObjectKeys(bucketName){
  const s3 = new AWS.S3();
  return new Promise((resolve, reject)=>{
    s3.listObjects({Bucket: bucketName, MaxKeys: 1000}, (err, data)=>{
      if (err){
        console.log(err, err.stack);
        reject(err);
        return;
      }

      resolve(data.Contents.map(c => c.Key));
    });
  });
}

function createIfNotExistsBucket(bucketName){
  const s3 = new AWS.S3();
  return new Promise((resolve, reject)=>{
    s3.listBuckets({}, (err, data)=>{
      if (err) {
        console.log(err, err.stack);
        reject(err);
        return;
      }

      console.log(`${data.Buckets.length} buckets`);
      for(const b of data.Buckets){
        if (b.Name === bucketName){
          console.log(`S3 Bucket ${bucketName} exists.`);
          getBucketObjectKeys(bucketName).then(resolve);
          return;
        }
      }

      const createOpts = {Bucket: bucketName, "ACL": "private", CreateBucketConfiguration: {LocationConstraint: "us-west-2"}};
      s3.createBucket(createOpts, (err, data)=>{
        if (err){
          console.log(err, err.stack);
          reject(err);
          return;
        }

        console.log(`Created S3 bucket ${bucketName}`);
        resolve([]);
      });

    });
  });
}

function readImage(filename){
  return new Promise((resolve, reject)=>{
    console.log(`Reading ${filename}`);
    const readable = fs.createReadStream(filename);
    const chunks = [];
    readable.on("data", (chunk)=>{
      chunks.push(chunk);
    }).on("error", (err) => {
      reject(err);
    }).on("end", _ => {
      const buffer = Buffer.concat(chunks);
      console.log(`Read ${buffer.length/1024} kb from image ${filename}.`);
      resolve(buffer);
    });    
  });
}

function uploadImage(bucketName, imageBuffer, imageMeta){
  const s3 = new AWS.S3();
  return new Promise((resolve, reject)=>{
    s3.upload({Bucket: BUCKET_NAME, Key: imageMeta.id, Body: imageBuffer}, (err, data)=>{
      if (err){
        console.log(err, err.stack);
        reject(err);
        return;
      }

      console.log(`Uploaded ${imageMeta.id} to bucket ${bucketName}`);
      resolve(data);
    });  
  });
}

function recognize(bucketName, imageMeta){
  return new Promise((resolve, reject)=>{
    const rek = new AWS.Rekognition();
    rek.detectLabels({
      Image: {
        S3Object: {
          Bucket: bucketName, 
          Name: imageMeta.id
        }
      },
      MaxLabels: 24,
      MinConfidence: 60
    }, (err, data) => {
      if (err){
        console.log(err, err.stack);
        reject(err);
        return;
      }

      const labels = data.Labels.map(l => l.Name);
      console.log(`${imageMeta.id}: ${labels.join(", ")}`)
      resolve(labels);
    });
  });
}

function saveLabeledImages(labeledImages){
  return new Promise((resolve, reject) =>  {
    fs.writeFile(path.join(__dirname, "../Images/", "labels.json"), JSON.stringify(labeledImages), (err)=>{
      if (err){
        console.log(err);
        reject(err);
      }

      resolve();
    });
  });
}

function processImages(images, bucketObjectKeys){
  return Promise.all(images.map((imageMeta) => new Promise((resolve, reject)=>{

    if (bucketObjectKeys.indexOf(imageMeta.id) >= 0){
      console.log(`Image ${imageMeta.id} already exists.`);
      resolve();
      return;
    };
    
    return readImage(imageMeta.filename)
      .then(imgBuffer => uploadImage(BUCKET_NAME, imgBuffer, imageMeta))
      .then(resolve)
      .catch(err => {
        reject(err);
      });

  }))).then(_=> images);
}

function labelImages(images){
  return Promise.all(images.map(imageMeta => 
    recognize(BUCKET_NAME, imageMeta)
    .then(data => {return {filename: path.basename(imageMeta.filename), id: imageMeta.id, labels: data}})));
}


/*
Create an S3 bucket if one doesn't exist
Upload all images to the S3 bucket. 
Only upload images that don't already exist.
Recognize labels for each image
*/
function runS3BucketUpload(){
  Promise.all([getImageMetadata(), createIfNotExistsBucket(BUCKET_NAME)]).then((results)=>{
    const [images, bucketObjectKeys] = results;

    return processImages(images, bucketObjectKeys)
      .then(labelImages)
      .then(saveLabeledImages)
      .then(_=> {
        console.log("done!");
      });

  }).catch(err => {
      console.log(err);
  });
}