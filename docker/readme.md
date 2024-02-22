Authentication integration with Github

* https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app


ECS Task Discovery:
* create monitoring-role in management account, which can assume monitoring role in environment accounts
* for each taskk

{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "arn:aws:iam::381779999363:root"
            },
            "Action": "sts:AssumeRole",
            "Condition": {}
        }
    ]
}

{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Sid": "Statement1",
			"Effect": "Allow",
			"Action": [
			    "ECS:ListClusters", 
			    "ECS:ListTasks", 
			    "EC2:DescribeInstances", 
			    "ECS:DescribeContainerInstances", 
			    "ECS:DescribeTasks", 
			    "ECS:DescribeTaskDefinition", 
			    "ECS:DescribeClusters"],
			"Resource": ["*"]
		}
	]
}