var http = require('http');
var url = require('url');

const region = "us-east-1";
const { AssumeRoleCommand, STSClient } = require("@aws-sdk/client-sts");
const { ECSClient, ListTasksCommand, DescribeTasksCommand, ListContainerInstancesCommand, DescribeContainerInstancesCommand } = require("@aws-sdk/client-ecs");
const { DescribeInstancesCommand, EC2Client } = require("@aws-sdk/client-ec2");

const getEC2PrivateAddress = async (instances, ec2Client) => {
  // Call the DescribeInstances API to get details of the EC2 instance
  const describeInstancesParams = {
    InstanceIds: instances
  };
  const describeInstancesData = await ec2Client.send(new DescribeInstancesCommand(describeInstancesParams));

  let instanceIdToIp = {}
  describeInstancesData.Reservations.map(r => r.Instances).flat().forEach(instance => {
    instanceIdToIp[instance.InstanceId] = instance.PrivateIpAddress
  })
  return instanceIdToIp
}

const getContainerInstanceARNToPrivateIPMapping = async (clusterArn, ecsClient, ec2Client) => {
  const listContainerInstancesCommand = new ListContainerInstancesCommand({ cluster: clusterArn });
  const listContainerInstancesResponse = await ecsClient.send(listContainerInstancesCommand);
  const containerInstanceArns = listContainerInstancesResponse.containerInstanceArns;
  if(listContainerInstancesResponse.containerInstanceArns?.length < 1) {
    return {}
  }

  const describeContainerInstancesCommand = new DescribeContainerInstancesCommand({
    cluster: clusterArn,
    containerInstances: containerInstanceArns
  });
  const describeContainerInstancesResponse = await ecsClient.send(describeContainerInstancesCommand);

  //TODO: consider pagination
  let arnToInstanceId = {};
  describeContainerInstancesResponse.containerInstances.forEach(containerInstance => {
    const instanceId = containerInstance.ec2InstanceId;
    arnToInstanceId[containerInstance.containerInstanceArn] = instanceId;
  });

  const instanceIdToIp = await getEC2PrivateAddress(Object.values(arnToInstanceId), ec2Client)

  let arnToIp = {};
  Object.entries(arnToInstanceId).forEach(entry => {
    const [arn, instanceId] = entry;
    arnToIp[arn] = instanceIdToIp[instanceId]
  })

  return arnToIp;
}

const describeAllTasks = async (clusterArn, taskArns, ecsClient) => {
  const describeTasksParams = {
    cluster: clusterArn,
    tasks: taskArns
  };
  const describeTasksData = await ecsClient.send(new DescribeTasksCommand(describeTasksParams));
  const tasks = describeTasksData.tasks.map(
    t => {
      let task = {}

      const containers = t.containers.filter(c => c.name == 'ecs_exporter')
      if(!containers[0]) {
        return task
      }
      const exporter = containers[0]
      if(exporter.networkInterfaces.length == 1) {
         task.networkType = 'eni'
         task.host = exporter.networkInterfaces[0].privateIpv4Address
         task.port = 9779 // TODO: support for other port number
      } else {
         task.networkType = 'bridged'
         task.host = t.containerInstanceArn // placeholder for host
         task.port = exporter.networkBindings[0]?.hostPort
      }
      
      return task
      
    })
    .filter(t => t.port !== undefined);

  return tasks
};


const listAllTasks = async (clusterArn, ecsClient, nextToken) => {
  const listTasksParams = {
    cluster: clusterArn
  };

  let tasks = []
  const listTasksData = await ecsClient.send(new ListTasksCommand(listTasksParams));
  if(listTasksData.taskArns.length < 1) {
    return []
  }

  const taskDetails = await describeAllTasks(clusterArn, listTasksData.taskArns, ecsClient)
  tasks = [...tasks, ...taskDetails]
  if (listTasksData.nextToken) {
    await listAllTasks(clusterArn, ecsClient, listTasksData.nextToken);
  }

  return tasks

}


http.createServer(async function (req, res) {
  console.log("Request received: ", req.url)
  let query = url.parse(req.url, true).query;

  const region = query.region
  const clusterArn = query.clusterArn
  const roleArn = query.roleArn

  if (!region || !clusterArn || !roleArn) {
    const message = { "message": "missing region, clusterArn or roleArn query params" }
    res.writeHead(400, { "content-type": "application/json" });
    res.write(JSON.stringify(message))
    res.end();
    return;
  }

  const stsClient = new STSClient({ region });

  const params = {
    RoleArn: roleArn,
    RoleSessionName: "ecs-service-discovery"
  };

  const creds = await stsClient.send(new AssumeRoleCommand(params));
  const ecsClient = new ECSClient({
    region,
    credentials: {
      accessKeyId: creds.Credentials.AccessKeyId,
      secretAccessKey: creds.Credentials.SecretAccessKey,
      sessionToken: creds.Credentials.SessionToken
    }
  });
  const ec2Client = new EC2Client({
    region: region,
    credentials: {
      accessKeyId: creds.Credentials.AccessKeyId,
      secretAccessKey: creds.Credentials.SecretAccessKey,
      sessionToken: creds.Credentials.SessionToken
    }
  });

  const instances = await getContainerInstanceARNToPrivateIPMapping(clusterArn, ecsClient, ec2Client)
  const tasks = await listAllTasks(clusterArn, ecsClient)
  let targets = tasks.map(t => {
    if(t.networkType == 'eni') {
        return `${t.host}:${t.port}`
    } else if(t.networkType == 'bridged') {
       const instanceIp = instances[t.host]
       return `${instanceIp}:${t.port}`
    }

    return ""
  }).filter(t => t != "")
  
  let resp = [
    {
      "targets": targets,
      "labels": {
        "region": region,
	"cluster": query.cluster,
	"env": query.env
      }
    }
  ]
  res.setHeader("content-type", "application/json")
  res.write(JSON.stringify(resp, null, 2));
  res.end();
}).listen(8080); 
